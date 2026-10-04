import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convertMarkdownToBlocks } from './markdown-to-blocks';
import { checkPlainTextEquivalence, markdownToPlainText } from './plain-text';
import { blocksToPlainText } from '@aivirteach/lesson-blocks';

describe('markdownToPlainText', () => {
  it('includes image alt and link text but excludes URLs', async () => {
    expect(
      await markdownToPlainText(
        '![diagram](image.png) [website](https://example.com) `code`',
      ),
    ).toBe('diagram website code');
  });
});

describe('checkPlainTextEquivalence', () => {
  const ctx = { assetIdsByFilename: new Map<string, string>() };

  it('accepts the sample lesson after accounting for intentionally dropped H1 text', async () => {
    const markdown = await readFile(
      join(__dirname, '../__fixtures__/sample-course/lesson-source.md'),
      'utf8',
    );
    const result = await convertMarkdownToBlocks(markdown, ctx);
    expect(await checkPlainTextEquivalence(markdown, result)).toMatchObject({
      equal: true,
    });
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
    expect(await checkPlainTextEquivalence(markdown, result)).toMatchObject({
      equal: true,
    });
  });

  it('excludes formatted H1 text while retaining matching text in the body', async () => {
    const markdown = '# **Title**\n\nTitle appears again.';
    const result = await convertMarkdownToBlocks(markdown, ctx);
    const comparison = await checkPlainTextEquivalence(markdown, result);
    expect(result.dropped).toContain('**Title**');
    expect(comparison.equal).toBe(true);
    expect(comparison.expected).toContain('Title appears again.');
  });

  it('normalizes ==highlight== in a dropped H1 before comparing', async () => {
    const markdown = '# ==Title==\n\nBody';
    const result = await convertMarkdownToBlocks(markdown, ctx);
    expect(await checkPlainTextEquivalence(markdown, result)).toMatchObject({
      equal: true,
    });
  });

  it('compares nested resolved and missing images once across lists, tables, and quotes', async () => {
    const markdown =
      '- List ![List alt](list.png)\n\n| Visual |\n| --- |\n| ![Table alt](missing.png) |\n\n> Quoted ![Quote alt](quote.png)\n\nBody mentions [图片缺失：missing.png].';
    const result = await convertMarkdownToBlocks(markdown, {
      assetIdsByFilename: new Map([
        ['list.png', 'list-id'],
        ['quote.png', 'quote-id'],
      ]),
    });
    const comparison = await checkPlainTextEquivalence(markdown, result);
    expect(comparison.equal).toBe(true);
    expect(comparison.actual).toContain('[图片缺失：missing.png]');
    const actual = blocksToPlainText(result.content);
    for (const alt of ['List alt', 'Table alt', 'Quote alt']) {
      expect(actual.split(alt)).toHaveLength(2);
    }
  });

  it('ignores generated filename alts when the source image alt is empty', async () => {
    const missingMarkdown = '![](missing.png)';
    const missingResult = await convertMarkdownToBlocks(missingMarkdown, ctx);
    expect(missingResult.content.blocks).toMatchObject([
      {
        type: 'paragraph',
        props: { text: '[图片缺失：missing.png] missing.png' },
      },
    ]);
    expect(Object.keys(missingResult)).toEqual([
      'content',
      'report',
      'dropped',
    ]);
    expect(
      (await checkPlainTextEquivalence(missingMarkdown, missingResult)).equal,
    ).toBe(true);

    const resolvedMarkdown = '![](resolved.png)\n\nBody repeats resolved.png.';
    const resolvedResult = await convertMarkdownToBlocks(resolvedMarkdown, {
      assetIdsByFilename: new Map([['resolved.png', 'resolved-id']]),
    });
    expect(resolvedResult.content.blocks).toMatchObject([
      { type: 'image', props: { alt: 'resolved.png' } },
      { type: 'paragraph', props: { text: 'Body repeats resolved.png.' } },
    ]);
    const resolvedComparison = await checkPlainTextEquivalence(
      resolvedMarkdown,
      resolvedResult,
    );
    expect(resolvedComparison.equal).toBe(true);
    expect(resolvedComparison.actual).toContain('Body repeats resolved.png.');
  });

  it('retains body text equal to a generated filename alt during comparison', async () => {
    const markdown = '![](missing.png)\n\nBody repeats missing.png.';
    const result = await convertMarkdownToBlocks(markdown, ctx);
    const comparison = await checkPlainTextEquivalence(markdown, result);
    expect(comparison.equal).toBe(true);
    expect(comparison.actual).toContain('Body repeats missing.png.');
  });

  it('keeps interleaved list and quote prose in order around their image blocks', async () => {
    const markdown =
      '- before **x ![List alt](list.png) y** after\n\n> before **x ![Quote alt](quote.png) y** after';
    const result = await convertMarkdownToBlocks(markdown, {
      assetIdsByFilename: new Map([
        ['list.png', 'list-id'],
        ['quote.png', 'quote-id'],
      ]),
    });
    expect((await checkPlainTextEquivalence(markdown, result)).equal).toBe(
      true,
    );
    expect(result.content.blocks.map(({ type }) => type)).toEqual([
      'bulletList',
      'image',
      'bulletList',
      'callout',
      'image',
      'callout',
    ]);
  });

  it('compares table cell prose and image alt once while retaining adjacent relocation', async () => {
    const markdown =
      '| Name | Description |\n| --- | --- |\n| row | before **x ![alt](a.png) y** after |\n\nLater paragraph.';
    const result = await convertMarkdownToBlocks(markdown, {
      assetIdsByFilename: new Map([['a.png', 'asset-a']]),
    });
    const comparison = await checkPlainTextEquivalence(markdown, result);
    expect(comparison.equal).toBe(true);
    expect(comparison.actual.split('alt')).toHaveLength(2);
    expect(result.content.blocks.map(({ type }) => type)).toEqual([
      'table',
      'image',
      'paragraph',
    ]);
  });

  it('treats tag-only and tagged raw html the same way on both sides', async () => {
    const markdown =
      'Intro\n\n<aside>\nℹ️\n\nNotion callout text.\n\n</aside>\n\n<div>x</div>\n\nOutro';
    const result = await convertMarkdownToBlocks(markdown, ctx);
    const check = await checkPlainTextEquivalence(markdown, result);
    expect(check.equal).toBe(true);
  });
});
