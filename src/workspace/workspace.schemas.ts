import { z } from 'zod';

export const CreateWorkspaceSchema = z.object({
  enrollmentId: z.string().min(1),
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;
