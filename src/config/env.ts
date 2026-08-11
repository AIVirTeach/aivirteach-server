import { z } from 'zod';

// 在进程启动时一次性校验，缺配置就直接崩，不要等到第一个请求进来才发现。
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少需要 32 个字符'),
  ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  PORT: z.coerce.number().int().positive().default(4000),
  // Tauri v2 webview 的源；本地网页调试再往白名单里追加
  CORS_ORIGINS: z.string().min(1).default('tauri://localhost'),
});

export type Env = z.infer<typeof EnvSchema>;

export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`环境变量校验失败：\n${detail}`);
  }

  return parsed.data;
}
