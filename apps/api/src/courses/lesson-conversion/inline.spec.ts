import { blocksToPlainText } from '@aivirteach/lesson-blocks';
import { inlineToMarkdownSubset } from './inline';

describe('inlineToMarkdownSubset', () => {
  it('maps supported phrasing, strips unsafe links, and unwraps deletion', async () => {
    const [{ unified }, { default: remarkParse }, { default: remarkGfm }] = await Promise.all([
      import('unified'), import('remark-parse'), import('remark-gfm'),
    ]);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(
      '**bold** *em* `code` [web](https://example.com)  \nnext [bad](javascript:alert(1)) ~~x~~',
    ) as import('mdast').Root;
    const report: Array<{ level: 'warning' | 'error'; code: string; message: string }> = [];
    const output = inlineToMarkdownSubset(tree.children[0].type === 'paragraph' ? tree.children[0].children : [], report);
    expect(output).toBe('**bold** *em* `code` [web](https://example.com)\nnext bad x');
    expect(report).toEqual([]);
  });

  it('escapes source characters so plain text round-trips exactly', async () => {
    const [{ unified }, { default: remarkParse }, { toString }] = await Promise.all([
      import('unified'), import('remark-parse'), import('mdast-util-to-string'),
    ]);
    const tree = unified().use(remarkParse).parse('2 * 3 = 6') as import('mdast').Root;
    const paragraph = tree.children[0];
    if (paragraph.type !== 'paragraph') throw new Error('expected paragraph');
    const output = inlineToMarkdownSubset(paragraph.children, []);
    expect(output).toContain('\\*');
    expect(output).toContain('\\=');
    expect(blocksToPlainText({ schemaVersion: 1, blocks: [{ id: 'b-001', type: 'paragraph', props: { text: output } }] })).toBe(toString(paragraph));
  });

  it('maps ==highlight== to bold and round-trips its text', async () => {
    const [{ unified }, { default: remarkParse }] = await Promise.all([import('unified'), import('remark-parse')]);
    const tree = unified().use(remarkParse).parse('==highlight==') as import('mdast').Root;
    const paragraph = tree.children[0];
    if (paragraph.type !== 'paragraph') throw new Error('expected paragraph');
    const output = inlineToMarkdownSubset(paragraph.children, []);
    expect(output).toBe('**highlight**');
    expect(blocksToPlainText({ schemaVersion: 1, blocks: [{ id: 'b-001', type: 'paragraph', props: { text: output } }] })).toBe('highlight');
  });
});
