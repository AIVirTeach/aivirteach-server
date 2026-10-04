import { collectInlineLinkTargets } from './derive';
import { LessonEnvelopeSchema } from './envelope';
import { BLOCK_REGISTRY } from './registry';
import type { BlockType } from './index.js';

export type ProblemCode =
  | 'invalid-envelope' | 'too-many-blocks' | 'too-large' | 'unknown-type'
  | 'invalid-props' | 'invalid-link' | 'duplicate-id' | 'unknown-asset' | 'step-gap'
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

// 只有显式带 scheme 的目标才需要白名单：#锚点、相对路径客户端会渲染成纯文本，不构成风险。
// 先按 WHATWG URL 解析器的方式去掉首尾空白和 tab/换行，避免 "java\tscript:" 之类绕过。
function isAllowedLinkTarget(rawTarget: string): boolean {
  let target = rawTarget.trim();
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(target);
  if (titled) target = titled[1];
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  target = target.replace(/[\t\n\r]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1].toLowerCase();
  if (scheme === undefined) return true;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

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
        const path = issue.path.length ? `props.${issue.path.join('.')}` : 'props';
        errors.push(problem('error', 'invalid-props', `${path}：${issue.message}`, id, blockIndex));
      }
    } else {
      const value = result.data as Record<string, unknown>;
      // 行内链接只放行 http/https/mailto；客户端渲染器也会过滤，这里是不依赖客户端实现的第二道防线。
      const { targets, complete } = collectInlineLinkTargets(type, value);
      for (const target of targets) {
        if (!isAllowedLinkTarget(target)) {
          errors.push(problem('error', 'invalid-link', `链接只允许 http、https 或 mailto：${target}`, id, blockIndex));
        }
      }
      if (!complete) errors.push(problem('error', 'invalid-link', '内容里的方括号/链接结构过于复杂，无法校验链接', id, blockIndex));
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
