import { z } from 'zod';

export const SendChatMessageSchema = z.object({
  text: z.string().min(1).max(4_000),
});

export type SendChatMessageInput = z.infer<typeof SendChatMessageSchema>;
