import { z } from 'zod';

export const ChatContextSchema = z
  .object({
    courseVersionId: z.string().min(1).max(200),
    lessonId: z.string().min(1).max(200),
    generation: z.number().int().nonnegative(),
  })
  .strict();

export const SendChatMessageSchema = z
  .object({
    requestId: z.string().uuid(),
    text: z.string().min(1).max(4_000),
    context: ChatContextSchema,
  })
  .strict();

export const ChatGenerationQuerySchema = z
  .object({
    generation: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .transform(Number)
      .pipe(z.number().int().nonnegative().max(2_147_483_647)),
  })
  .strict();

export type SendChatMessageInput = z.infer<typeof SendChatMessageSchema>;
