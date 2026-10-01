import { z } from 'zod';

export const HeadingPropsSchema = z.object({
  level: z.union([z.literal(2), z.literal(3)], { error: '标题 level 必须为 2 或 3' }),
  text: z.string().max(200, '标题文字不能超过 200 个字符'),
});

export const ParagraphPropsSchema = z.object({
  text: z.string().min(1, '段落文字不能为空').max(5000, '段落文字不能超过 5000 个字符'),
});

export const ListPropsSchema = z.object({
  items: z.array(z.string().max(500, '列表项不能超过 500 个字符'))
    .min(1, '列表至少需要 1 项')
    .max(50, '列表不能超过 50 项'),
});

export const CodePropsSchema = z.object({
  kind: z.enum(['terminal', 'file', 'plain'], { error: '代码块 kind 必须为 terminal、file 或 plain' }),
  code: z.string().min(1, '代码不能为空').max(20000, '代码不能超过 20000 个字符'),
  language: z.string().max(30, 'language 不能超过 30 个字符').optional(),
  label: z.string().max(80, 'label 不能超过 80 个字符').optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'file' && !value.label) {
    ctx.addIssue({ code: 'custom', path: ['label'], message: 'file 类型代码块必须提供 label' });
  }
});

export const StepPropsSchema = z.object({
  number: z.number().int().min(1, '步骤 number 不能小于 1').max(99, '步骤 number 不能大于 99'),
  title: z.string().min(1, '步骤标题不能为空').max(120, '步骤标题不能超过 120 个字符'),
  body: z.string().max(2000, '步骤正文不能超过 2000 个字符').optional(),
});

export const CalloutPropsSchema = z.object({
  variant: z.enum(['tip', 'warning', 'note'], { error: '提示框 variant 必须为 tip、warning 或 note' }),
  title: z.string().max(60, '提示框标题不能超过 60 个字符').optional(),
  body: z.string().min(1, '提示框正文不能为空').max(2000, '提示框正文不能超过 2000 个字符'),
});

export const DividerPropsSchema = z.object({}).strict();
