import { z } from 'zod';

export const RecordPracticeSchema = z.object({
  minutes: z.number().int().positive().max(600),
});

export type RecordPracticeInput = z.infer<typeof RecordPracticeSchema>;
