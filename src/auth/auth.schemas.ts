import { z } from 'zod';

// 密码下限 8 位，与 acceptInvitation 的实际写入路径保持一致。
export const AcceptInvitationSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, '密码至少 8 位'),
});

export const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
