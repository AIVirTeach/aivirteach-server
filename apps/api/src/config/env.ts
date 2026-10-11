import { z } from 'zod';

// 留空（如 TOKEN_WEIGHT_OUTPUT=）按未设置处理：z.coerce.number() 会把 '' 变成 0，
// 等于悄悄让这一类 token 免费。
const tokenWeight = (fallback: number) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().nonnegative().default(fallback),
  );

// 在进程启动时一次性校验，缺配置就直接崩，不要等到第一个请求进来才发现。
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少需要 32 个字符'),
  ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
  // 运营后台只发 access 令牌（不发 refresh），过期重新登录；格式同 ACCESS_TOKEN_TTL。
  OPERATOR_SESSION_TTL: z.string().min(1).default('8h'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  PORT: z.coerce.number().int().positive().default(4000),
  // Tauri v2 webview 的源；本地网页调试再往白名单里追加
  CORS_ORIGINS: z.string().min(1).default('tauri://localhost'),
  // Labs 的 VM 生命周期接口——本地/CI 不配这几个也要能跑，缺配置只在真正调用
  // LabsClient 时报错，不在进程启动时让整个 server 起不来。
  LABS_VM_BASE_URL: z.url().optional(),
  AIVIRTEACH_API_TOKEN: z.string().min(1).optional(),
  // Vercel Cron 用来重试待删除的 VM；未配置时维护端点拒绝所有请求。
  CRON_SECRET: z.string().min(16).optional(),
  // Labs 的 POST /v1/vms/{lab_id}/browser-sessions 用这个鉴权，是跟 AIVIRTEACH_API_TOKEN
  // 不同的静态密钥；两者是否配置了且不相同的校验在 LabsClient.createBrowserSession() 里做，
  // 不在这里（延续本文件其余 Labs 变量"缺配置不让整个 server 起不来"的约定）。
  AIVIRTEACH_SESSION_TOKEN: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_ID: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().min(1).optional(),
  // Guacamole 真实地址（含路径前缀，如 https://xxx.trycloudflare.com/guacamole/），只在
  // server 端使用，不进浏览器 bundle。server 用它转发 POST /api/tokens 换 authToken——
  // Guacamole 默认不带 CORS 响应头，浏览器没法直接跨域 fetch 这一步；WebSocket tunnel 本身
  // 不受 CORS 限制，浏览器换到 authToken 后直接跨域连真实地址开 WS，不需要同源反代。
  LABS_GUACAMOLE_BASE_URL: z.url().optional(),
  // aivirteach-labs 的诊断 Agent（POST /v1/agent/diagnose）；本地/CI 不配也要能跑，
  // 缺配置只在真正调用 AgentClient 时报错，不在进程启动时让整个 server 起不来
  // （跟本文件其余 Labs 变量的约定一致）。
  LABS_AGENT_BASE_URL: z.url().optional(),
  // server-to-Agent 共享密钥，必须跟 Labs 那边 agent-service/config/agent.env 里的
  // AIVIRTEACH_AGENT_TOKEN 是同一个值（模式跟 AIVIRTEACH_API_TOKEN 一致：两边变量名
  // 相同、值抄一份，不是同一套密钥体系）。
  AIVIRTEACH_AGENT_TOKEN: z.string().min(1).optional(),
  // 心跳超时兜底：workspace RUNNING 且 lastSeenAt 超过这个分钟数没更新，就被
  // sweepIdle 判定为空闲并停止。关标签页时 sendBeacon 立即停是主路径，这个只是安全网。
  WORKSPACE_IDLE_TIMEOUT_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
  // token 额度强制开关。默认关闭：只记录用量、不拦截，等运营给用户发好额度（quota:grant-tokens）
  // 再打开，否则上线瞬间所有没有额度的用户都会被 429。只认 'true'/'false'，不用
  // z.coerce.boolean——它会把字符串 'false' 当成真值。
  TOKEN_QUOTA_ENFORCED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // 三类 token 折算成额度的权重，以未命中输入 = 1 为基准。默认值取自 DeepSeek flash 的
  // 价格比例（缓存命中 0.003 : 未命中 0.15 : 输出 0.6 美元/百万 token，高峰/低谷同比例）；
  // 换模型或价格变了要同步调整。
  TOKEN_WEIGHT_CACHE_HIT: tokenWeight(0.02),
  TOKEN_WEIGHT_INPUT_MISS: tokenWeight(1),
  TOKEN_WEIGHT_OUTPUT: tokenWeight(4),
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
