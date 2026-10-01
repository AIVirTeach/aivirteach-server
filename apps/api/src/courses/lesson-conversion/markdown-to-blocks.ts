import type { Nodes, Root, PhrasingContent } from 'mdast';
import type { LessonContent, LessonBlock } from '@aivirteach/lesson-blocks';
import { validateLessonContent } from '@aivirteach/lesson-blocks';
import { inlineToMarkdownSubset } from './inline';

export type ConversionIssue = {
  level: 'warning' | 'error';
  code: string;
  message: string;
  line?: number;
};

export type ConversionResult = {
  content: LessonContent;
  report: ConversionIssue[];
  dropped: string[];
  /** Comparison-only generated text, keyed by block id; never applied to content. */
  equivalenceIgnoredTextByBlockId?: Readonly<Record<string, readonly string[]>>;
};

type Context = { assetIdsByFilename: ReadonlyMap<string, string> };

export async function convertMarkdownToBlocks(
  markdown: string,
  ctx: Context,
): Promise<ConversionResult> {
  // Keep parser packages out of API startup; they are loaded only for conversion.
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { toString }] = await Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
    import('mdast-util-to-string'),
  ]);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const report: ConversionIssue[] = [];
  const dropped: string[] = [];
  const equivalenceIgnoredTextByBlockId: Record<string, string[]> = {};
  const blocks: LessonBlock[] = [];
  const append = (type: string, props: unknown) => {
    const id = `b-${String(blocks.length + 1).padStart(3, '0')}`;
    blocks.push({ id, type, props });
    return id;
  };
  const plainText = (node: Nodes) => toString(node).trim();
  const withoutImages = (node: PhrasingContent): PhrasingContent | undefined => {
    if (node.type === 'image' || node.type === 'imageReference') return undefined;
    if ('children' in node) {
      return { ...node, children: node.children.map((child) => withoutImages(child as PhrasingContent)).filter(Boolean) } as PhrasingContent;
    }
    return node;
  };
  const inline = (children: PhrasingContent[]) => inlineToMarkdownSubset(
    children.map(withoutImages).filter((child): child is PhrasingContent => child !== undefined), report,
  );
  const assetDefinitions = new Map(tree.children.flatMap((node) => node.type === 'definition' ? [[node.identifier, node.url] as const] : []));
  type ImageNode = Extract<Nodes, { type: 'image' | 'imageReference' }>;
  const imageBlock = (node: ImageNode) => {
    const url = node.type === 'image' ? node.url : (assetDefinitions.get(node.identifier) ?? node.identifier);
    const filename = url.split(/[\\/]/).filter(Boolean).at(-1) || url;
    const sourceAlt = node.alt?.trim() ?? '';
    const generatedAlt = !sourceAlt;
    const alt = sourceAlt || filename;
    if (generatedAlt) {
      report.push({ level: 'warning', code: 'empty-alt-defaulted', message: `图片缺少替代文字，已使用文件名：${filename}`, line: node.position?.start.line });
    }
    const assetId = ctx.assetIdsByFilename.get(filename);
    if (!assetId) {
      report.push({ level: 'warning', code: 'missing-asset', message: `找不到图片素材：${filename}`, line: node.position?.start.line });
      const label = `[图片缺失：${filename}]`;
      const placeholderId = append('paragraph', { text: `${label}${alt ? ` ${alt}` : ''}` });
      equivalenceIgnoredTextByBlockId[placeholderId] = [label, ...(generatedAlt ? [` ${alt}`] : [])];
      return;
    }
    const imageId = append('image', { assetId, alt });
    if (generatedAlt) equivalenceIgnoredTextByBlockId[imageId] = [alt];
  };
  const nestedImages = (node: Nodes): ImageNode[] => {
    if (node.type === 'image' || node.type === 'imageReference') return [node];
    if ('children' in node) return node.children.flatMap((child) => nestedImages(child as Nodes));
    return [];
  };
  const emitNestedImages = (node: Nodes) => nestedImages(node).forEach(imageBlock);
  const quotedText = (node: Nodes): string[] => {
    if (node.type === 'paragraph' || node.type === 'heading') return [inline(node.children)];
    if (node.type === 'code') return [node.value];
    if (node.type === 'html') return [node.value.replace(/<[^>]*>/g, '').trim()];
    if ('children' in node) return node.children.flatMap((child) => quotedText(child as Nodes)).filter(Boolean);
    return [plainText(node)];
  };
  const unmappedText = (node: Nodes) => {
    const text = node.type === 'html' ? node.value.replace(/<[^>]*>/g, '').trim() : plainText(node);
    append('paragraph', { text: text || '（未映射内容）' });
    report.push({ level: 'warning', code: 'unmapped-node', message: `未映射的 Markdown 节点：${node.type}`, line: node.position?.start.line });
  };

  for (const node of tree.children) {
    if (node.type === 'heading') {
      const text = inline(node.children).trim();
      if (node.depth === 1) {
        dropped.push(text);
        report.push({ level: 'warning', code: 'h1-dropped', message: '一级标题不会转换为课时内容块。', line: node.position?.start.line });
      } else {
        append('heading', { level: node.depth === 2 ? 2 : 3, text });
      }
      emitNestedImages(node);
    } else if (node.type === 'thematicBreak') {
      append('divider', {});
    } else if (node.type === 'code') {
      const language = node.lang || undefined;
      const terminalLanguages = new Set(['bash', 'sh', 'shell', 'console', 'zsh']);
      append('code', {
        kind: language && terminalLanguages.has(language) ? 'terminal' : 'plain',
        code: node.value,
        ...(language ? { language } : {}),
      });
    } else if (node.type === 'table') {
      const rows = node.children.map((row) => row.children.map((cell) => inline(cell.children).trim()));
      append('table', { columns: rows[0] ?? [], rows: rows.slice(1) });
      emitNestedImages(node);
    } else if (node.type === 'list') {
      const items: string[] = [];
      let flattenedNestedList = false;
      const visitListItem = (item: Extract<Nodes, { type: 'listItem' }>) => {
        for (const child of item.children) {
          if (child.type === 'list') {
            flattenedNestedList = true;
            child.children.forEach(visitListItem);
          } else {
            const text = child.type === 'paragraph' ? inline(child.children).trim() : plainText(child);
            if (text) items.push(text);
          }
        }
      };
      node.children.forEach(visitListItem);
      if (items.length) append(node.ordered ? 'numberedList' : 'bulletList', { items });
      emitNestedImages(node);
      if (flattenedNestedList) {
        report.push({ level: 'warning', code: 'nested-list-flattened', message: '嵌套列表已拍平。', line: node.position?.start.line });
      }
    } else if (node.type === 'paragraph') {
      let phrasing: PhrasingContent[] = [];
      const flush = () => {
        const text = inline(phrasing).trim();
        if (text) append('paragraph', { text });
        phrasing = [];
      };
      for (const child of node.children) {
        if (child.type === 'image' || child.type === 'imageReference') {
          flush();
          imageBlock(child);
          continue;
        }
        phrasing.push(child);
        const images = nestedImages(child as Nodes);
        if (images.length) {
          flush();
          images.forEach(imageBlock);
        }
      }
      flush();
    } else if (node.type === 'blockquote') {
      const body = node.children.flatMap(quotedText).join('\n').trim();
      if (body) append('callout', { variant: 'note', body });
      emitNestedImages(node);
    } else if (node.type === 'definition') {
      continue;
    } else if (node.type === 'html') {
      unmappedText(node);
    } else {
      unmappedText(node);
    }
  }

  const content: LessonContent = { schemaVersion: 1, blocks };
  const validation = validateLessonContent(content, { courseAssetIds: new Set(ctx.assetIdsByFilename.values()) });
  for (const problem of validation.errors) report.push({ level: 'error', code: 'invalid-output', message: problem.message });
  const result: ConversionResult = { content, report, dropped };
  Object.defineProperty(result, 'equivalenceIgnoredTextByBlockId', { value: equivalenceIgnoredTextByBlockId });
  return result;
}
