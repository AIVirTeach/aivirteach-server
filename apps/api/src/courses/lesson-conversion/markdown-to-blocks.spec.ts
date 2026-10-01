import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blocksToPlainText } from '@aivirteach/lesson-blocks';
import { convertMarkdownToBlocks } from './markdown-to-blocks';

const ctx = { assetIdsByFilename: new Map<string, string>() };
const blocks = async (markdown: string) => (await convertMarkdownToBlocks(markdown, ctx)).content.blocks;

describe('convertMarkdownToBlocks', () => {
  it('converts the sample lesson source into blocks without losing its paragraph text', async () => {
    const source = await readFile(join(__dirname, '../__fixtures__/sample-course/lesson-source.md'), 'utf8');
    const result = await convertMarkdownToBlocks(source, ctx);

    expect(result.content.schemaVersion).toBe(1);
    expect(result.content.blocks.map((block) => block.type)).toEqual([
      'paragraph', 'heading', 'paragraph', 'heading', 'paragraph',
    ]);
    expect(result.dropped).toContain('Intro');
    expect(blocksToPlainText(result.content)).toContain('Welcome.');
    expect(blocksToPlainText(result.content)).toContain('Section two body.');
  });

  it('maps second and third level headings, and lowers deeper headings to level three', async () => {
    const result = await blocks('## A\n### B\n#### C');
    expect(result.map(({ type, props }) => [type, props])).toEqual([
      ['heading', { level: 2, text: 'A' }],
      ['heading', { level: 3, text: 'B' }],
      ['heading', { level: 3, text: 'C' }],
    ]);
  });

  it('drops H1 while reporting its plain text', async () => {
    const result = await convertMarkdownToBlocks('Intro paragraph.\n\n# T', ctx);
    expect(result.content.blocks.map(({ type }) => type)).toEqual(['paragraph']);
    expect(result.report).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warning', code: 'h1-dropped', line: 3 }),
    ]));
    expect(result.dropped).toContain('T');
  });

  it.each(['bash', 'sh', 'shell', 'console', 'zsh'])('marks %s fences as terminal code', async (language) => {
    const [block] = await blocks(`\`\`\`${language}\nrun\n\`\`\``);
    expect(block.type).toBe('code');
    expect(block.props).toMatchObject({ kind: 'terminal', language, code: 'run' });
    expect(block.props).not.toHaveProperty('label');
  });

  it.each([['python', 'python'], ['ts', 'ts'], ['', undefined]])(
    'keeps %s fences as plain code', async (fence, language) => {
      const [block] = await blocks(`\`\`\`${fence}\nconst x = 1;\n\`\`\``);
      expect(block.type).toBe('code');
      expect(block.props).toMatchObject({ kind: 'plain', code: 'const x = 1;' });
      expect((block.props as { language?: string }).language).toBe(language);
      expect(block.props).not.toHaveProperty('label');
    },
  );

  it('converts a GFM table into columns and rows', async () => {
    const [block] = await blocks('| Name | Count |\n| --- | --- |\n| A | 2 |\n| B | 3 |');
    expect(block).toMatchObject({
      type: 'table',
      props: { columns: ['Name', 'Count'], rows: [['A', '2'], ['B', '3']] },
    });
  });

  it('maps a thematic break to a divider', async () => {
    expect(await blocks('---')).toMatchObject([{ type: 'divider', props: {} }]);
  });

  it('flattens nested list items and reports the flattening', async () => {
    const result = await convertMarkdownToBlocks('List intro.\n\n- one\n  - child\n- two', ctx);
    expect(result.content.blocks).toMatchObject([
      { type: 'paragraph', props: { text: 'List intro.' } },
      { type: 'bulletList', props: { items: ['one', 'child', 'two'] } },
    ]);
    expect(result.report).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warning', code: 'nested-list-flattened', line: 3 }),
    ]));
  });

  it('maps ordered lists and assigns unique source-order block ids', async () => {
    const result = await convertMarkdownToBlocks('## A\n\n1. one\n2. two\n\n---\n\ntext', ctx);
    const ids = result.content.blocks.map(({ id }) => id);
    expect(ids).toEqual(['b-001', 'b-002', 'b-003', 'b-004']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.content.blocks[1]).toMatchObject({ type: 'numberedList', props: { items: ['one', 'two'] } });
  });

  it('preserves the plain text of each source paragraph', async () => {
    const sourceParagraphs = ['Alpha paragraph.', 'Beta paragraph with **formatting**.'];
    const result = await convertMarkdownToBlocks(sourceParagraphs.join('\n\n'), ctx);
    const plainText = blocksToPlainText(result.content).trim();
    for (const paragraph of sourceParagraphs) {
      expect(plainText).toContain(paragraph.replaceAll('**', ''));
    }
  });

  it('maps images, missing assets, blockquotes, and raw HTML with explicit fallbacks', async () => {
    const result = await convertMarkdownToBlocks(
      '![Diagram](folder/a.png)\n\n![No asset](missing.png)\n\n> 提示\n\n<div>x</div>',
      { assetIdsByFilename: new Map([['a.png', 'asset-a']]) },
    );
    expect(result.content.blocks).toMatchObject([
      { type: 'image', props: { assetId: 'asset-a', alt: 'Diagram' } },
      { type: 'paragraph', props: { text: '[图片缺失：missing.png]' } },
      { type: 'callout', props: { variant: 'note', body: '提示' } },
      { type: 'paragraph', props: { text: 'x' } },
    ]);
    expect(result.report).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warning', code: 'missing-asset' }),
      expect.objectContaining({ level: 'warning', code: 'unmapped-node' }),
    ]));
  });

  it('defaults an empty image alt to the resolved filename', async () => {
    const result = await convertMarkdownToBlocks('![](images/a.png)', {
      assetIdsByFilename: new Map([['a.png', 'asset-a']]),
    });
    expect(result.content.blocks[0]).toMatchObject({ type: 'image', props: { assetId: 'asset-a', alt: 'a.png' } });
    expect(result.report).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warning', code: 'empty-alt-defaulted' }),
    ]));
  });

  it('validates converted content and reports invalid block properties', async () => {
    const code = `\`\`\`\n${'x'.repeat(20_001)}\n\`\`\``;
    const paragraph = 'y'.repeat(5_001);
    const result = await convertMarkdownToBlocks(`${code}\n\n${paragraph}`, ctx);
    expect(result.report.filter(({ code }) => code === 'invalid-output')).toHaveLength(2);
  });

  it('has no validation errors for legal conversions', async () => {
    const result = await convertMarkdownToBlocks('## Intro\n\nText\n\n- one\n- two\n\n> note', ctx);
    expect(result.report.filter(({ level }) => level === 'error')).toEqual([]);
  });
});
