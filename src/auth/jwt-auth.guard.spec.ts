import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { signAccessToken } from './tokens';

const SECRET = 'a'.repeat(48);
const ENV_STUB = {
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: SECRET,
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 3000,
  CORS_ORIGINS: 'tauri://localhost',
};

const contextWith = (headers: Record<string, string>) => {
  const request: Record<string, unknown> = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    __request: request,
  } as unknown as ExecutionContext & { __request: Record<string, unknown> };
};

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard(ENV_STUB);

  it('合法 token 放行并把身份挂到 request.auth', async () => {
    const token = await signAccessToken(
      { sub: 'user_1', email: 'a@b.com' },
      SECRET,
      '15m',
    );
    const context = contextWith({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(context.__request.auth).toEqual({
      userId: 'user_1',
      email: 'a@b.com',
    });
  });

  it('缺 Authorization 头时拒绝', async () => {
    await expect(guard.canActivate(contextWith({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('不是 Bearer 格式时拒绝', async () => {
    const context = contextWith({ authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('签名不符的 token 被拒绝', async () => {
    const token = await signAccessToken(
      { sub: 'user_1', email: 'a@b.com' },
      'b'.repeat(48),
      '15m',
    );
    const context = contextWith({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
