import { blocksToPlainText, collectImageAssetIds, countRenderableBlocks } from './derive';

const block = (id: string, type: string, props: unknown) => ({ id, type, props });
const content = (blocks: unknown[]) => ({ schemaVersion: 1, blocks });

describe('lesson content derived helpers', () => {
  it('counts known valid blocks except empty headings and all-empty lists', () => {
    expect(countRenderableBlocks(content([
      block('h', 'heading', { level: 2, text: '  ' }), block('l', 'bulletList', { items: [' ', '\n'] }),
      block('bad', 'paragraph', {}), block('unknown', 'custom', {}), block('p', 'paragraph', { text: 'Visible' }),
    ]))).toBe(1);
  });

  it('collects unique image asset ids and handles invalid input', () => {
    expect(collectImageAssetIds(content([
      block('a', 'image', { assetId: 'asset-1', alt: 'A' }), block('b', 'image', { assetId: 'asset-1', alt: 'B' }),
      block('c', 'image', { assetId: 'asset-2', alt: 'C' }), block('bad', 'image', { assetId: '', alt: 'D' }),
    ]))).toEqual(['asset-1', 'asset-2']);
    expect(collectImageAssetIds(null)).toEqual([]);
  });

  it('extracts plain text from inline marks and links', () => {
    expect(blocksToPlainText(content([block('p', 'paragraph', { text: '**a** *b* ==c== `d` [e](https://x.y) \\*f\\* \\=g\\=' })])))
      .toBe('a b c d e *f* =g=');
  });

  it('preserves code source and extracts links with balanced destinations', () => {
    const code = '*value* `literal` [label](url)';
    expect(blocksToPlainText(content([
      block('c', 'code', { kind: 'plain', code }),
      block('a', 'annotatedCode', { steps: [{ label: 'Step', code, terms: [] }] }),
      block('p', 'paragraph', { text: '[x](https://a.test/a_(b))' }),
    ]))).toBe(`${code}\nStep\n${code}\nx`);
  });

  it('preserves literal sentinel-shaped text', () => {
    expect(blocksToPlainText(content([block('p', 'paragraph', { text: '\u0000123\u0000 and \\*literal\\*' })])))
      .toBe('\u0000123\u0000 and *literal*');
  });

  it('includes code descriptions in visible plain text', () => {
    expect(blocksToPlainText(content([block('c', 'code', { kind: 'plain', code: 'const x = 1', description: 'Example code' })])))
      .toBe('const x = 1\nExample code');
  });

  it('includes table cells and image alt text', () => {
    const tableText = blocksToPlainText(content([block('t', 'table', { columns: ['A', 'B'], rows: [['1', '2']] })]));
    expect(tableText.split('\n')).toEqual(['A', 'B', '1', '2']);
    expect(blocksToPlainText(content([block('i', 'image', { assetId: 'asset', alt: 'Diagram', caption: 'Caption' })]))).toContain('Diagram');
  });
});
