import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convertMarkdownToBlocks } from './markdown-to-blocks';
import { checkPlainTextEquivalence, markdownToPlainText } from './plain-text';

describe('markdownToPlainText', () => {
  it('includes image alt and link text but excludes URLs', async () => {
    expect(await markdownToPlainText('![diagram](image.png) [website](https://example.com) `code`')).toBe('diagram website code');
  });
});

describe('checkPlainTextEquivalence', () => {
  const ctx = { assetIdsByFilename: new Map<string, string>() };

  it('accepts the sample lesson after accounting for intentionally dropped H1 text', async () => {
    const markdown = await readFile(join(__dirname, '../__fixtures__/sample-course/lesson-source.md'), 'utf8');
    const result = await convertMarkdownToBlocks(markdown, ctx);
    expect(await checkPlainTextEquivalence(markdown, result)).toMatchObject({ equal: true });
  });

  it('shows expected and actual text when one converted character differs', async () => {
    const markdown = 'hello';
    const result = await convertMarkdownToBlocks(markdown, ctx);
    (result.content.blocks[0].props as { text: string }).text = 'hullo';
    const comparison = await checkPlainTextEquivalence(markdown, result);
    expect(comparison.equal).toBe(false);
    expect(comparison.expected).toContain('hello');
    expect(comparison.actual).toContain('hullo');
  });

  it('treats dropped H1 text as removed from the expected source', async () => {
    const markdown = '# 标题\n\n正文';
    const result = await convertMarkdownToBlocks(markdown, ctx);
    expect(await checkPlainTextEquivalence(markdown, result)).toMatchObject({ equal: true });
  });
});
