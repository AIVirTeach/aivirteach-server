export const BLOCK_TYPES = [
  'heading',
  'paragraph',
  'bulletList',
  'numberedList',
  'code',
  'step',
  'callout',
  'table',
  'image',
  'resourceLink',
  'divider',
  'annotatedCode',
  'diagram',
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export type LessonBlock = { id: string; type: string; props: unknown };
export type LessonContent = { schemaVersion: 1; blocks: LessonBlock[] };

export { LessonEnvelopeSchema } from './envelope';
export {
  CalloutPropsSchema,
  CodePropsSchema,
  DividerPropsSchema,
  HeadingPropsSchema,
  ListPropsSchema,
  ParagraphPropsSchema,
  StepPropsSchema,
} from './blocks/simple';
export {
  AnnotatedCodePropsSchema,
  DiagramPropsSchema,
  ImagePropsSchema,
  ResourceLinkPropsSchema,
  TablePropsSchema,
} from './blocks/complex';
export { BLOCK_REGISTRY } from './registry';
export { validateLessonContent } from './validate';
export type { Problem, ProblemCode, ValidationReport } from './validate';
export { blocksToPlainText, collectImageAssetIds, collectInlineLinkTargets, countRenderableBlocks } from './derive';
