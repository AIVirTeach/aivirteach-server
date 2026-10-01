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
