import { z } from 'zod';
import {
  AnnotatedCodePropsSchema,
  DiagramPropsSchema,
  ImagePropsSchema,
  ResourceLinkPropsSchema,
  TablePropsSchema,
} from './blocks/complex';
import {
  CalloutPropsSchema,
  CodePropsSchema,
  DividerPropsSchema,
  HeadingPropsSchema,
  ListPropsSchema,
  ParagraphPropsSchema,
  StepPropsSchema,
} from './blocks/simple';
import type { BlockType } from './index.js';

type BlockRegistryEntry = { label: string; schema: z.ZodType; defaultProps: () => unknown };

export const BLOCK_REGISTRY: Record<BlockType, BlockRegistryEntry> = {
  heading: { label: '标题', schema: HeadingPropsSchema, defaultProps: () => ({ level: 2, text: '' }) },
  paragraph: { label: '段落', schema: ParagraphPropsSchema, defaultProps: () => ({ text: '内容' }) },
  bulletList: { label: '无序列表', schema: ListPropsSchema, defaultProps: () => ({ items: [''] }) },
  numberedList: { label: '有序列表', schema: ListPropsSchema, defaultProps: () => ({ items: [''] }) },
  code: { label: '代码', schema: CodePropsSchema, defaultProps: () => ({ kind: 'terminal', code: ' ' }) },
  step: { label: '步骤', schema: StepPropsSchema, defaultProps: () => ({ number: 1, title: '步骤' }) },
  callout: { label: '提示框', schema: CalloutPropsSchema, defaultProps: () => ({ variant: 'note', body: '说明' }) },
  table: { label: '表格', schema: TablePropsSchema, defaultProps: () => ({ columns: [''], rows: [] }) },
  image: { label: '图片', schema: ImagePropsSchema, defaultProps: () => '' },
  resourceLink: { label: '资源链接', schema: ResourceLinkPropsSchema, defaultProps: () => ({ url: 'https://example.com', title: '链接' }) },
  divider: { label: '分隔线', schema: DividerPropsSchema, defaultProps: () => ({}) },
  annotatedCode: { label: '批注代码', schema: AnnotatedCodePropsSchema, defaultProps: () => ({ steps: [{ label: '步骤', code: ' ', terms: [] }] }) },
  diagram: { label: '流程图', schema: DiagramPropsSchema, defaultProps: () => ({ nodes: [{ id: 'start', title: '开始' }, { id: 'end', title: '结束' }], connections: [] }) },
};
