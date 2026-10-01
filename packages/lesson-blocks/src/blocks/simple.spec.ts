import {
  CalloutPropsSchema,
  CodePropsSchema,
  DividerPropsSchema,
  HeadingPropsSchema,
  ListPropsSchema,
  ParagraphPropsSchema,
  StepPropsSchema,
} from './simple';

describe('simple lesson block schemas', () => {
  it('accepts heading levels 2 and 3, empty text, and 200 characters', () => {
    expect(HeadingPropsSchema.safeParse({ level: 2, text: '' }).success).toBe(true);
    expect(HeadingPropsSchema.safeParse({ level: 3, text: 'x'.repeat(200) }).success).toBe(true);
    expect(HeadingPropsSchema.safeParse({ level: 1, text: 'x' }).success).toBe(false);
    expect(HeadingPropsSchema.safeParse({ level: 4, text: 'x' }).success).toBe(false);
    expect(HeadingPropsSchema.safeParse({ level: 2, text: 'x'.repeat(201) }).success).toBe(false);
  });

  it('bounds paragraph text', () => {
    expect(ParagraphPropsSchema.safeParse({ text: 'x' }).success).toBe(true);
    expect(ParagraphPropsSchema.safeParse({ text: 'x'.repeat(5000) }).success).toBe(true);
    expect(ParagraphPropsSchema.safeParse({ text: '' }).success).toBe(false);
    expect(ParagraphPropsSchema.safeParse({ text: 'x'.repeat(5001) }).success).toBe(false);
  });

  it('bounds list items', () => {
    expect(ListPropsSchema.safeParse({ items: ['x'] }).success).toBe(true);
    expect(ListPropsSchema.safeParse({ items: Array(50).fill('x'.repeat(500)) }).success).toBe(true);
    expect(ListPropsSchema.safeParse({ items: [] }).success).toBe(false);
    expect(ListPropsSchema.safeParse({ items: Array(51).fill('x') }).success).toBe(false);
    expect(ListPropsSchema.safeParse({ items: ['x'.repeat(501)] }).success).toBe(false);
  });

  it('requires labels for file code and bounds code metadata', () => {
    expect(CodePropsSchema.safeParse({ kind: 'file', code: 'x' }).success).toBe(false);
    expect(CodePropsSchema.safeParse({ kind: 'terminal', code: 'x' }).success).toBe(true);
    expect(CodePropsSchema.safeParse({ kind: 'plain', code: 'x'.repeat(20000), language: 'x'.repeat(30) }).success).toBe(true);
    expect(CodePropsSchema.safeParse({ kind: 'plain', code: 'x', description: 'x'.repeat(500) }).success).toBe(true);
    expect(CodePropsSchema.safeParse({ kind: 'plain', code: 'x'.repeat(20001) }).success).toBe(false);
    expect(CodePropsSchema.safeParse({ kind: 'plain', code: 'x', description: 'x'.repeat(501) }).success).toBe(false);
    expect(CodePropsSchema.safeParse({ kind: 'plain', code: 'x', language: 'x'.repeat(31) }).success).toBe(false);
  });

  it('bounds step number and title', () => {
    expect(StepPropsSchema.safeParse({ number: 1, title: 'x' }).success).toBe(true);
    expect(StepPropsSchema.safeParse({ number: 99, title: 'x'.repeat(120) }).success).toBe(true);
    expect(StepPropsSchema.safeParse({ number: 0, title: 'x' }).success).toBe(false);
    expect(StepPropsSchema.safeParse({ number: 100, title: 'x' }).success).toBe(false);
    expect(StepPropsSchema.safeParse({ number: 1, title: '' }).success).toBe(false);
  });

  it('validates callout variants and body', () => {
    expect(CalloutPropsSchema.safeParse({ variant: 'tip', body: 'x' }).success).toBe(true);
    expect(CalloutPropsSchema.safeParse({ variant: 'danger', body: 'x' }).success).toBe(false);
    expect(CalloutPropsSchema.safeParse({ variant: 'note', body: '' }).success).toBe(false);
  });

  it('rejects extra divider properties', () => {
    expect(DividerPropsSchema.safeParse({}).success).toBe(true);
    expect(DividerPropsSchema.safeParse({ label: 'extra' }).success).toBe(false);
  });
});
