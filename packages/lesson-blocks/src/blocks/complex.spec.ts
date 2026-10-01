import {
  AnnotatedCodePropsSchema,
  DiagramPropsSchema,
  ImagePropsSchema,
  ResourceLinkPropsSchema,
  TablePropsSchema,
} from './complex';

describe('complex lesson block schemas', () => {
  it('bounds table dimensions and requires row arity to match columns', () => {
    expect(TablePropsSchema.safeParse({ columns: ['a', 'b'], rows: [['1', '2'], ['3', '4']] }).success).toBe(true);
    expect(TablePropsSchema.safeParse({ columns: Array(9).fill('c'), rows: [] }).success).toBe(false);
    expect(TablePropsSchema.safeParse({ columns: ['a'], rows: Array(51).fill(['x']) }).success).toBe(false);
    expect(TablePropsSchema.safeParse({ columns: ['a', 'b', 'c'], rows: [['x', 'y']] }).success).toBe(false);
  });

  it('requires image asset and alt text and bounds its caption', () => {
    expect(ImagePropsSchema.safeParse({ assetId: 'asset-1', alt: '' }).success).toBe(false);
    expect(ImagePropsSchema.safeParse({ alt: 'description' }).success).toBe(false);
    expect(ImagePropsSchema.safeParse({ assetId: 'asset-1', alt: 'image', caption: 'x'.repeat(301) }).success).toBe(false);
  });

  it('only accepts resource URLs with allowed protocols', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x', 'not a url']) {
      expect(ResourceLinkPropsSchema.safeParse({ url, title: 'Link' }).success).toBe(false);
    }
    expect(ResourceLinkPropsSchema.safeParse({ url: 'https://a.com', title: 'Link' }).success).toBe(true);
    expect(ResourceLinkPropsSchema.safeParse({ url: 'mailto:a@b.c', title: 'Link' }).success).toBe(true);
  });

  it('bounds annotated code steps and terms', () => {
    const step = { label: 'Step', code: 'x' };
    expect(AnnotatedCodePropsSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ steps: Array(21).fill(step) }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ steps: [{ ...step, code: '' }] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ steps: [{ ...step, terms: Array(11).fill({ term: 'x', description: 'y' }) }] }).success).toBe(false);
  });

  it('bounds diagram nodes and validates unique ids and connection references', () => {
    const nodes = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }];
    expect(DiagramPropsSchema.safeParse({ nodes: [nodes[0]], connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ nodes: Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, title: 'Node' })), connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ nodes, connections: [{ from: 'a', to: 'missing' }] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ nodes: [{ id: 'a', title: 'A' }, { id: 'a', title: 'Again' }], connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ nodes, connections: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'Next' }] }).success).toBe(true);
  });
});
