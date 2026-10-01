import { z } from 'zod';

const LessonBlockShellSchema = z.object({
  id: z.string().min(1, '块 id 不能为空').max(64, '块 id 不能超过 64 个字符'),
  type: z.string(),
  props: z.object({}).passthrough(),
});

export const LessonEnvelopeSchema = z.object({
  schemaVersion: z.literal(1, { error: '课时内容 schemaVersion 必须为 1' }),
  blocks: z.array(LessonBlockShellSchema),
});
