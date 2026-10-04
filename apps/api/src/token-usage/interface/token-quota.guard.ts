import {
  CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../../auth/jwt-auth.guard';
import { ENV, type Env } from '../../config/env';
import { CheckTokenQuota } from '../application/check-token-quota';

// 放在 Guard 而不是 ChatService：流式路由用 @Sse()，Nest 会先写 200 的 SSE 响应头再订阅
// generator，在 service 里抛异常变不成真正的 HTTP 429。Guard 在 handler 之前执行，
// 普通和流式两条路由都能拿到 429。必须排在 JwtAuthGuard 之后（需要 request.auth）。
@Injectable()
export class TokenQuotaGuard implements CanActivate {
  private readonly logger = new Logger(TokenQuotaGuard.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly checkTokenQuota: CheckTokenQuota,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.env.TOKEN_QUOTA_ENFORCED) return true;

    const { userId } = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().auth!;
    let verdict: Awaited<ReturnType<CheckTokenQuota['execute']>>;
    try {
      verdict = await this.checkTokenQuota.execute(userId);
    } catch (error) {
      // fail-open：计量查询失败不该挡住学习；聊天主路径依赖同一个库，真故障会在别处暴露。
      this.logger.error(
        `userId=${userId} 额度检查失败，放行`,
        error instanceof Error ? error.stack : String(error),
      );
      return true;
    }

    if (verdict.verdict === 'exhausted') {
      throw new HttpException(
        {
          code: 'TOKEN_QUOTA_EXHAUSTED',
          message: 'AI 助教的使用额度已用完，请联系运营补充额度。',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
