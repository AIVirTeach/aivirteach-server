import { z } from 'zod';

// 入库、登录、CLI 都经过这里：trim + 小写后，`Op@X.com ` 与 `op@x.com` 是同一个运营。
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email());

// 上限 128 位，超长直接 400，不交给 argon2 去算。
export const MAX_PASSWORD_LENGTH = 128;

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
