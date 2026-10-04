import { validateLessonContent } from './validate';

const block = (id: string, type: string, props: unknown) => ({ id, type, props });
const valid = (blocks: unknown[]) => ({ schemaVersion: 1, blocks });

describe('validateLessonContent', () => {
  it('accepts legal blocks', () => {
    expect(validateLessonContent(valid([
      block('h1', 'heading', { level: 2, text: 'Title' }),
      block('p1', 'paragraph', { text: 'Body' }),
    ]), { courseAssetIds: new Set() })).toEqual({ errors: [], warnings: [] });
  });

  it.each([null, 'x', [], {}])('reports one invalid-envelope for %p without throwing', (input) => {
    expect(() => validateLessonContent(input, { courseAssetIds: new Set() })).not.toThrow();
    const result = validateLessonContent(input, { courseAssetIds: new Set() });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalid-envelope');
    expect(result.warnings).toEqual([]);
  });

  it('reports block count and serialized size limits', () => {
    const tooMany = valid(Array.from({ length: 301 }, (_, i) => block(`p${i}`, 'paragraph', { text: 'x' })));
    expect(validateLessonContent(tooMany, { courseAssetIds: new Set() }).errors.map((p) => p.code)).toContain('too-many-blocks');
    const tooLarge = valid(Array.from({ length: 14 }, (_, i) => block(`c${i}`, 'code', { kind: 'plain', code: 'x'.repeat(20000) })));
    expect(validateLessonContent(tooLarge, { courseAssetIds: new Set() }).errors.map((p) => p.code)).toContain('too-large');
  });

  it('accepts exactly 256 KiB and rejects one byte over using UTF-8 size', () => {
    const makeContent = (paddingLength: number, padding = 'x') => valid([
      block('p', 'paragraph', { text: 'x', padding: padding.repeat(paddingLength) }),
    ]);
    const baseSize = new TextEncoder().encode(JSON.stringify(makeContent(0))).byteLength;
    const exact = makeContent(256 * 1024 - baseSize);
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(256 * 1024);
    expect(validateLessonContent(exact, { courseAssetIds: new Set() }).errors.map((p) => p.code)).not.toContain('too-large');
    const over = makeContent(256 * 1024 - baseSize + 1);
    expect(validateLessonContent(over, { courseAssetIds: new Set() }).errors.map((p) => p.code)).toContain('too-large');
    const multibyte = makeContent(Math.ceil((256 * 1024 - baseSize) / 2) + 1, 'é');
    expect(validateLessonContent(multibyte, { courseAssetIds: new Set() }).errors.map((p) => p.code)).toContain('too-large');
  });

  it('identifies unknown types and invalid props with block location', () => {
    const result = validateLessonContent(valid([
      block('quiz', 'quiz-widget', {}), block('image', 'image', { assetId: 'a', alt: '' }),
    ]), { courseAssetIds: new Set() });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown-type', blockId: 'quiz', blockIndex: 0 }),
      expect.objectContaining({ code: 'invalid-props', blockId: 'image', blockIndex: 1, message: expect.stringMatching(/^props\.alt：.*不能为空$/) }),
    ]));
  });

  it('reports repeated ids only on the later block and unknown assets', () => {
    const result = validateLessonContent(valid([
      block('same', 'paragraph', { text: 'A' }), block('same', 'image', { assetId: 'missing', alt: 'A' }),
    ]), { courseAssetIds: new Set() });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate-id', blockId: 'same', blockIndex: 1 }),
      expect.objectContaining({ code: 'unknown-asset', blockId: 'same', blockIndex: 1 }),
    ]));
    expect(result.errors.filter((p) => p.code === 'duplicate-id')).toHaveLength(1);
  });

  it('returns every independent error', () => {
    const result = validateLessonContent(valid([
      block('dup', 'quiz-widget', {}), block('dup', 'image', { assetId: 'gone', alt: '' }),
    ]), { courseAssetIds: new Set() });
    expect(result.errors.map((p) => p.code)).toEqual(expect.arrayContaining(['unknown-type', 'invalid-props', 'duplicate-id', 'unknown-asset']));
  });

  it('reports step gaps, heading skips, empty headings, and empty content as warnings', () => {
    const result = validateLessonContent(valid([
      block('s1', 'step', { number: 1, title: 'One' }), block('s3', 'step', { number: 3, title: 'Three' }),
      block('h3', 'heading', { level: 3, text: 'Sub' }), block('h2', 'heading', { level: 2, text: '  ' }),
    ]), { courseAssetIds: new Set() });
    expect(result.warnings.map((p) => p.code)).toEqual(expect.arrayContaining(['step-gap', 'heading-skip', 'empty-heading']));
    expect(result.errors).toEqual([]);
    const empty = validateLessonContent(valid([]), { courseAssetIds: new Set() });
    expect(empty.warnings.map((p) => p.code)).toContain('no-blocks');
    expect(empty.errors).toEqual([]);
  });

  describe('inline link targets', () => {
    const ctx = { courseAssetIds: new Set<string>() };
    const codes = (blocks: unknown[]) => validateLessonContent(valid(blocks), ctx).errors.map((p) => p.code);

    it.each([
      ['paragraph', { text: '见 [x](javascript:alert(1))' }],
      ['bulletList', { items: ['ok', '[x](data:text/html,hi)'] }],
      ['callout', { variant: 'note', body: '[x](/relative)' }],
      ['step', { number: 1, title: '[x](vbscript:run)' }],
      ['table', { columns: ['a'], rows: [['[x](javascript:1)']] }],
      ['annotatedCode', { steps: [{ label: 'a', code: ' ', explanation: '[x](javascript:1)', terms: [] }] }],
      ['paragraph', { text: '**[x](javascript:1)**' }],
    ])('rejects a disallowed link in %s', (type, props) => {
      expect(codes([block('b', type, props)])).toContain('invalid-link');
    });

    it('accepts http, https and mailto links and ignores link-looking text inside code spans', () => {
      expect(codes([
        block('a', 'paragraph', { text: '[a](https://example.com) [b](http://example.com/x?y=(1)) [c](mailto:a@b.co)' }),
        block('b', 'paragraph', { text: '`[x](javascript:1)` 只是代码' }),
      ])).toEqual([]);
    });

    it('reports the block that holds the bad link', () => {
      const result = validateLessonContent(valid([
        block('ok', 'paragraph', { text: 'fine' }),
        block('bad', 'paragraph', { text: '[x](javascript:1)' }),
      ]), ctx);
      expect(result.errors).toEqual([expect.objectContaining({ code: 'invalid-link', blockId: 'bad', blockIndex: 1 })]);
    });
  });
});
