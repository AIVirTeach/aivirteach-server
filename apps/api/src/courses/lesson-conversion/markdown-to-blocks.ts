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
  const blocks: LessonBlock[] = [];
  const append = (type: string, props: unknown) => {
    blocks.push({ id: `b-${String(blocks.length + 1).padStart(3, '0')}`, type, props });
  };
  const plainText = (node: Nodes) => toString(node).trim();
  const inline = (children: PhrasingContent[]) => inlineToMarkdownSubset(children, report);
  const imageBlock = (node: Extract<Nodes, { type: 'image' }>) => {
    const filename = node.url.split(/[\\/]/).filter(Boolean).at(-1) || node.url;
    const assetId = ctx.assetIdsByFilename.get(filename);
    if (!assetId) {
      report.push({ level: 'warning', code: 'missing-asset', message: `找不到图片素材：${filename}`, line: node.position?.start.line });
      append('paragraph', { text: `[图片缺失：${filename}]` });
      return;
    }
    let alt = node.alt?.trim() ?? '';
    if (!alt) {
      alt = filename;
      report.push({ level: 'warning', code: 'empty-alt-defaulted', message: `图片缺少替代文字，已使用文件名：${filename}`, line: node.position?.start.line });
    }
    append('image', { assetId, alt });
  };
  const unmappedText = (node: Nodes) => {
    const text = node.type === 'html' ? node.value.replace(/<[^>]*>/g, '').trim() : plainText(node);
    append('paragraph', { text: text || '（未映射内容）' });
    report.push({ level: 'warning', code: 'unmapped-node', message: `未映射的 Markdown 节点：${node.type}`, line: node.position?.start.line });
  };

  for (const node of tree.children) {
    if (node.type === 'heading') {
      const text = inline(node.children);
      if (node.depth === 1) {
        dropped.push(text);
        report.push({ level: 'warning', code: 'h1-dropped', message: '一级标题不会转换为课时内容块。', line: node.position?.start.line });
      } else {
        append('heading', { level: node.depth === 2 ? 2 : 3, text });
      }
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
      const rows = node.children.map((row) => row.children.map((cell) => inline(cell.children)));
      append('table', { columns: rows[0] ?? [], rows: rows.slice(1) });
    } else if (node.type === 'list') {
      const items: string[] = [];
      let flattenedNestedList = false;
      const visitListItem = (item: Extract<Nodes, { type: 'listItem' }>) => {
        for (const child of item.children) {
          if (child.type === 'list') {
            flattenedNestedList = true;
            child.children.forEach(visitListItem);
          } else {
            const text = child.type === 'paragraph' ? inline(child.children) : plainText(child);
            if (text) items.push(text);
          }
        }
      };
      node.children.forEach(visitListItem);
      append(node.ordered ? 'numberedList' : 'bulletList', { items });
      if (flattenedNestedList) {
        report.push({ level: 'warning', code: 'nested-list-flattened', message: '嵌套列表已拍平。', line: node.position?.start.line });
      }
    } else if (node.type === 'paragraph') {
      let phrasing: PhrasingContent[] = [];
      const flush = () => {
        if (phrasing.length) append('paragraph', { text: inline(phrasing) });
        phrasing = [];
      };
      for (const child of node.children) {
        if (child.type === 'image') {
          flush();
          imageBlock(child);
        } else {
          phrasing.push(child);
        }
      }
      flush();
    } else if (node.type === 'blockquote') {
      append('callout', { variant: 'note', body: inline(node.children.flatMap((child) => child.type === 'paragraph' ? child.children : [])) });
    } else if (node.type === 'html') {
      unmappedText(node);
    } else {
      unmappedText(node);
    }
  }

  const content: LessonContent = { schemaVersion: 1, blocks };
  const validation = validateLessonContent(content, { courseAssetIds: new Set(ctx.assetIdsByFilename.values()) });
  for (const problem of validation.errors) report.push({ level: 'error', code: 'invalid-output', message: problem.message });
  return { content, report, dropped };
}
