import type { ConversionResult } from './markdown-to-blocks';

export async function markdownToPlainText(markdown: string): Promise<string> {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { toString }] = await Promise.all([
    import('unified'), import('remark-parse'), import('remark-gfm'), import('mdast-util-to-string'),
  ]);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  return toString(tree);
}

export async function checkPlainTextEquivalence(
  markdown: string,
  result: ConversionResult,
): Promise<{ equal: boolean; expected: string; actual: string }> {
  let expected = await markdownToPlainText(markdown);
  for (const dropped of result.dropped) expected = expected.split(dropped).join('');
  const actual = (await import('@aivirteach/lesson-blocks')).blocksToPlainText(result.content);
  const normalize = (value: string) => value.replace(/\s/gu, '');
  return { equal: normalize(expected) === normalize(actual), expected, actual };
}
