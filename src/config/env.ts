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
  // Labs 的 VM 生命周期接口——本地/CI 不配这几个也要能跑，缺配置只在真正调用
  // LabsClient 时报错，不在进程启动时让整个 server 起不来。
  LABS_VM_BASE_URL: z.url().optional(),
  AIVIRTEACH_API_TOKEN: z.string().min(1).optional(),
  // Labs 的 POST /v1/vms/{lab_id}/browser-sessions 用这个鉴权，是跟 AIVIRTEACH_API_TOKEN
  // 不同的静态密钥；两者是否配置了且不相同的校验在 LabsClient.createBrowserSession() 里做，
  // 不在这里（延续本文件其余 Labs 变量"缺配置不让整个 server 起不来"的约定）。
  AIVIRTEACH_SESSION_TOKEN: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_ID: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().min(1).optional(),
  // Guacamole webapp 的 https:// 根路径，给浏览器建 Guacamole 会话用；
  // 跟 LABS_VM_BASE_URL（VM 生命周期 HTTP API）是两个不同用途的地址。
  // 必须以 / 结尾——client 侧 `console-viewer.tsx` 直接字符串拼接
  // `${guacamoleBaseUrl}api/tokens`/`${wsBase}websocket-tunnel`，不在这里强制的话，
  // 少了结尾斜杠会拼出一个语法正确但指向错误主机的 URL，报错会很难查。
  LABS_GUACAMOLE_BASE_URL: z
    .url()
    .refine((value) => value.endsWith('/'), 'LABS_GUACAMOLE_BASE_URL 必须以 / 结尾（Guacamole webapp 根路径）')
    .optional(),
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
