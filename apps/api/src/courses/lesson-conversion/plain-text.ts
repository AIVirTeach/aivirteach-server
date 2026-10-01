import { blocksToPlainText } from '@aivirteach/lesson-blocks';
import type { Nodes, Root } from 'mdast';
import type { ConversionResult } from './markdown-to-blocks';
import { inlineToMarkdownSubset } from './inline';
import { getConversionComparisonMetadata, withoutGeneratedComparisonText } from './comparison-metadata';

async function parseMarkdown(markdown: string): Promise<{ tree: Root; toString: (node: Nodes | Root) => string }> {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { toString }] = await Promise.all([
    import('unified'), import('remark-parse'), import('remark-gfm'), import('mdast-util-to-string'),
  ]);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  return { tree, toString };
}

export async function markdownToPlainText(markdown: string): Promise<string> {
  const { tree, toString } = await parseMarkdown(markdown);
  return toString(tree);
}

export async function checkPlainTextEquivalence(
  markdown: string,
  result: ConversionResult,
): Promise<{ equal: boolean; expected: string; actual: string }> {
  const { tree, toString } = await parseMarkdown(markdown);
  const droppedCounts = new Map<string, number>();
  for (const dropped of result.dropped) {
    const plainDropped = blocksToPlainText({ schemaVersion: 1, blocks: [{ id: 'drop', type: 'paragraph', props: { text: dropped } }] });
    droppedCounts.set(plainDropped, (droppedCounts.get(plainDropped) ?? 0) + 1);
  }
  const expected = tree.children.filter((node) => {
    if (node.type !== 'heading' || node.depth !== 1) return true;
    const mappedHeading = inlineToMarkdownSubset(node.children, []);
    const plainHeading = blocksToPlainText({ schemaVersion: 1, blocks: [{ id: 'heading', type: 'paragraph', props: { text: mappedHeading } }] });
    const remaining = droppedCounts.get(plainHeading) ?? 0;
    if (remaining === 0) return true;
    if (remaining === 1) droppedCounts.delete(plainHeading);
    else droppedCounts.set(plainHeading, remaining - 1);
    return false;
  }).map(toString).join('\n');
  const comparableContent = withoutGeneratedComparisonText(result.content, getConversionComparisonMetadata(result));
  const actual = blocksToPlainText(comparableContent);
  const normalize = (value: string) => value.replace(/\s/gu, '');
  return { equal: normalize(expected) === normalize(actual), expected, actual };
}
