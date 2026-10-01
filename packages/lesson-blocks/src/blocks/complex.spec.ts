import {
  AnnotatedCodePropsSchema,
  DiagramPropsSchema,
  ImagePropsSchema,
  ResourceLinkPropsSchema,
  TablePropsSchema,
} from './complex';

const repeated = (length: number) => 'x'.repeat(length);
const validAnnotatedStep = () => ({ label: 'Step', code: 'x', terms: [] as Array<{ term: string; description: string }> });
const validDiagramNode = (id = 'node') => ({ id, title: 'Node' });

describe('complex lesson block schemas', () => {
  it('bounds table dimensions and requires row arity to match columns', () => {
    expect(TablePropsSchema.safeParse({ columns: ['a', 'b'], rows: [['1', '2'], ['3', '4']] }).success).toBe(true);
    expect(TablePropsSchema.safeParse({ columns: Array(9).fill('c'), rows: [] }).success).toBe(false);
    expect(TablePropsSchema.safeParse({ columns: ['a'], rows: Array(51).fill(['x']) }).success).toBe(false);
    expect(TablePropsSchema.safeParse({ columns: ['a', 'b', 'c'], rows: [['x', 'y']] }).success).toBe(false);
  });

  it('accepts table maxima and rejects column and cell text over the limit', () => {
    const maxColumns = Array(8).fill(repeated(300));
    const maxRows = Array.from({ length: 50 }, () => Array(8).fill(repeated(300)));
    expect(TablePropsSchema.safeParse({ columns: maxColumns, rows: maxRows }).success).toBe(true);
    expect(TablePropsSchema.safeParse({ columns: [repeated(301)], rows: [] }).success).toBe(false);
    expect(TablePropsSchema.safeParse({ columns: ['column'], rows: [[repeated(301)]] }).success).toBe(false);
  });

  it('requires image asset and alt text and bounds its caption', () => {
    expect(ImagePropsSchema.safeParse({ assetId: 'asset-1', alt: '' }).success).toBe(false);
    expect(ImagePropsSchema.safeParse({ alt: 'description' }).success).toBe(false);
    expect(ImagePropsSchema.safeParse({ assetId: 'asset-1', alt: 'image', caption: 'x'.repeat(301) }).success).toBe(false);
  });

  it('accepts the maximum image alt length', () => {
    expect(ImagePropsSchema.safeParse({ assetId: 'asset-1', alt: repeated(300) }).success).toBe(true);
    expect(ImagePropsSchema.safeParse({ assetId: 'asset-1', alt: repeated(301) }).success).toBe(false);
  });

  it('only accepts resource URLs with allowed protocols', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x', 'not a url']) {
      expect(ResourceLinkPropsSchema.safeParse({ url, title: 'Link' }).success).toBe(false);
    }
    expect(ResourceLinkPropsSchema.safeParse({ url: 'https://a.com', title: 'Link' }).success).toBe(true);
    expect(ResourceLinkPropsSchema.safeParse({ url: 'mailto:a@b.c', title: 'Link' }).success).toBe(true);
  });

  it('accepts resource link title and description maxima and rejects overflow', () => {
    const maxProps = { url: 'https://a.com', title: repeated(120), description: repeated(300) };
    expect(ResourceLinkPropsSchema.safeParse(maxProps).success).toBe(true);
    expect(ResourceLinkPropsSchema.safeParse({ ...maxProps, title: repeated(121) }).success).toBe(false);
    expect(ResourceLinkPropsSchema.safeParse({ ...maxProps, description: repeated(301) }).success).toBe(false);
  });

  it('bounds annotated code steps and terms', () => {
    const step = validAnnotatedStep();
    expect(AnnotatedCodePropsSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ steps: Array(21).fill(step) }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ steps: [{ ...step, code: '' }] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ steps: [{ ...step, terms: Array(11).fill({ term: 'x', description: 'y' }) }] }).success).toBe(false);
  });

  it('accepts annotated code maxima and rejects each field over its limit', () => {
    const step = {
      label: repeated(80),
      code: repeated(10000),
      explanationTitle: repeated(80),
      explanation: repeated(1000),
      terms: Array(10).fill({ term: repeated(60), description: repeated(300) }),
    };
    const maximum = { title: repeated(120), fileLabel: repeated(80), steps: Array(20).fill(step) };
    expect(AnnotatedCodePropsSchema.safeParse(maximum).success).toBe(true);
    expect(AnnotatedCodePropsSchema.safeParse({ ...maximum, title: repeated(121) }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ ...maximum, fileLabel: repeated(81) }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ ...maximum, steps: [{ ...step, label: repeated(81) }] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ ...maximum, steps: [{ ...step, code: repeated(10001) }] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ ...maximum, steps: [{ ...step, explanationTitle: repeated(81) }] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ ...maximum, steps: [{ ...step, explanation: repeated(1001) }] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ ...maximum, steps: [{ ...step, terms: [{ term: repeated(61), description: 'd' }] }] }).success).toBe(false);
    expect(AnnotatedCodePropsSchema.safeParse({ ...maximum, steps: [{ ...step, terms: [{ term: 't', description: repeated(301) }] }] }).success).toBe(false);
  });

  it('bounds diagram nodes and validates unique ids and connection references', () => {
    const nodes = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }];
    expect(DiagramPropsSchema.safeParse({ nodes: [nodes[0]], connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ nodes: Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, title: 'Node' })), connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ nodes, connections: [{ from: 'a', to: 'missing' }] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ nodes: [{ id: 'a', title: 'A' }, { id: 'a', title: 'Again' }], connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ nodes, connections: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'Next' }] }).success).toBe(true);
  });

  it('accepts diagram maxima and rejects each bounded field over the limit', () => {
    const maximum = {
      title: repeated(120),
      nodes: Array.from({ length: 12 }, (_, i) => ({
        id: `${String(i).padStart(2, '0')}${repeated(62)}`,
        title: repeated(60),
        description: repeated(200),
      })),
      connections: [{ from: `00${repeated(62)}`, to: `01${repeated(62)}`, label: repeated(40) }],
    };
    expect(DiagramPropsSchema.safeParse(maximum).success).toBe(true);
    expect(DiagramPropsSchema.safeParse({ ...maximum, title: repeated(121) }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ ...maximum, nodes: [{ ...validDiagramNode(), id: repeated(65) }, validDiagramNode('other')], connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ ...maximum, nodes: [{ ...validDiagramNode(), title: repeated(61) }, validDiagramNode('other')], connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ ...maximum, nodes: [{ ...validDiagramNode(), description: repeated(201) }, validDiagramNode('other')], connections: [] }).success).toBe(false);
    expect(DiagramPropsSchema.safeParse({ ...maximum, connections: [{ from: maximum.nodes[0].id, to: maximum.nodes[1].id, label: repeated(41) }] }).success).toBe(false);
  });
});
