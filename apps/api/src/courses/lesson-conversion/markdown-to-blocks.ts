import type { Nodes, Root } from 'mdast';
import type { LessonContent, LessonBlock } from '@aivirteach/lesson-blocks';

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
  _ctx: Context,
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

  for (const node of tree.children) {
    if (node.type === 'heading') {
      const text = plainText(node);
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
      const rows = node.children.map((row) => row.children.map(plainText));
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
            const text = plainText(child);
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
      append('paragraph', { text: plainText(node) });
    }
  }

  return { content: { schemaVersion: 1, blocks }, report, dropped };
}
