import { z } from 'zod';

export const CreateWorkspaceSchema = z.object({
  enrollmentId: z.string().min(1),
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

export const ExchangeConsoleTokenSchema = z.object({
  data: z.string().min(1),
});

export type ExchangeConsoleTokenInput = z.infer<typeof ExchangeConsoleTokenSchema>;

export const StopWorkspaceSchema = z.object({
  reason: z.enum(['manual', 'beacon']).default('manual'),
});

export type StopWorkspaceInput = z.infer<typeof StopWorkspaceSchema>;
