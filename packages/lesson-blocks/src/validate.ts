import { LessonEnvelopeSchema } from './envelope';
import { BLOCK_REGISTRY } from './registry';
import type { BlockType } from './index.js';

export type ProblemCode =
  | 'invalid-envelope' | 'too-many-blocks' | 'too-large' | 'unknown-type'
  | 'invalid-props' | 'duplicate-id' | 'unknown-asset' | 'step-gap'
  | 'heading-skip' | 'empty-heading' | 'no-blocks';

export type Problem = {
  level: 'error' | 'warning';
  code: ProblemCode;
  message: string;
  blockId?: string;
  blockIndex?: number;
};

export type ValidationReport = { errors: Problem[]; warnings: Problem[] };

const knownBlockType = (type: string): type is BlockType => Object.hasOwn(BLOCK_REGISTRY, type);
const problem = (level: Problem['level'], code: ProblemCode, message: string, blockId?: string, blockIndex?: number): Problem => ({
  level, code, message, ...(blockId === undefined ? {} : { blockId }), ...(blockIndex === undefined ? {} : { blockIndex }),
});

export function validateLessonContent(input: unknown, ctx: { courseAssetIds: ReadonlySet<string> }): ValidationReport {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  let parsed: ReturnType<typeof LessonEnvelopeSchema.safeParse>;
  try {
    parsed = LessonEnvelopeSchema.safeParse(input);
  } catch {
    return { errors: [problem('error', 'invalid-envelope', '课时内容格式无效')], warnings };
  }
  if (!parsed.success) return { errors: [problem('error', 'invalid-envelope', '课时内容格式无效')], warnings };
  const { blocks } = parsed.data;
  if (blocks.length > 300) errors.push(problem('error', 'too-many-blocks', '课时内容不能超过 300 个块'));
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 256 * 1024) {
      errors.push(problem('error', 'too-large', '课时内容不能超过 256 KB'));
    }
  } catch {
    return { errors: [problem('error', 'invalid-envelope', '课时内容格式无效')], warnings: [] };
  }
  if (blocks.length === 0) warnings.push(problem('warning', 'no-blocks', '课时内容没有内容块'));

  const seenIds = new Set<string>();
  let previousStep: number | undefined;
  let hasSeenH2 = false;
  blocks.forEach((block, blockIndex) => {
    const { id, type, props } = block;
    if (!knownBlockType(type)) {
      errors.push(problem('error', 'unknown-type', `未知内容块类型：${type}`, id, blockIndex));
      if (seenIds.has(id)) errors.push(problem('error', 'duplicate-id', `内容块 id 重复：${id}`, id, blockIndex));
      seenIds.add(id);
      return;
    }
    if (type === 'image' && typeof props === 'object' && props !== null) {
      const assetId = (props as Record<string, unknown>).assetId;
      if (typeof assetId === 'string' && assetId.length > 0 && !ctx.courseAssetIds.has(assetId)) {
        errors.push(problem('error', 'unknown-asset', `图片资源不存在：${assetId}`, id, blockIndex));
      }
    }
    const result = BLOCK_REGISTRY[type].schema.safeParse(props);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path.length ? issue.path.join('.') : 'props';
        errors.push(problem('error', 'invalid-props', `${path}：${issue.message}`, id, blockIndex));
      }
    } else {
      const value = result.data as Record<string, unknown>;
      if (type === 'step' && typeof value.number === 'number') {
        if (previousStep !== undefined && value.number !== previousStep + 1) {
          warnings.push(problem('warning', 'step-gap', `步骤编号应从 ${previousStep + 1} 开始`, id, blockIndex));
        }
        previousStep = value.number;
      }
      if (type === 'heading') {
        if (typeof value.text === 'string' && value.text.trim() === '') {
          warnings.push(problem('warning', 'empty-heading', '标题不能为空', id, blockIndex));
        }
        if (value.level === 2) hasSeenH2 = true;
        if (value.level === 3 && !hasSeenH2) warnings.push(problem('warning', 'heading-skip', '三级标题前应先有二级标题', id, blockIndex));
      }
    }
    if (seenIds.has(id)) errors.push(problem('error', 'duplicate-id', `内容块 id 重复：${id}`, id, blockIndex));
    seenIds.add(id);
  });
  return { errors, warnings };
}
