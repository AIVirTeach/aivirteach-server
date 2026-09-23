import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
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
  WORKSPACE_IDLE_TIMEOUT_MINUTES: 15,
};

const contextWith = (headers: Record<string, string>, query: Record<string, string> = {}) => {
  const request: Record<string, unknown> = { headers, query };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => contextWith,
    getClass: () => JwtAuthGuard,
    __request: request,
  } as unknown as ExecutionContext & { __request: Record<string, unknown> };
};

function reflectorAllowing(allowed: boolean): Reflector {
  return { getAllAndOverride: () => allowed } as unknown as Reflector;
}

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard(ENV_STUB, reflectorAllowing(true));

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

  it('没有 Authorization 头时，回退到 query string 里的 token（sendBeacon 不能带自定义头）', async () => {
    const token = await signAccessToken(
      { sub: 'user_1', email: 'a@b.com' },
      SECRET,
      '15m',
    );
    const context = contextWith({}, { token });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(context.__request.auth).toEqual({
      userId: 'user_1',
      email: 'a@b.com',
    });
  });

  it('query token 无效时拒绝', async () => {
    const context = contextWith({}, { token: 'not-a-real-token' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('handler 没标 @AllowQueryToken() 时，即使 query token 合法也拒绝——只有明确开放的端点才回退到 query string', async () => {
    const scopedGuard = new JwtAuthGuard(ENV_STUB, reflectorAllowing(false));
    const token = await signAccessToken(
      { sub: 'user_1', email: 'a@b.com' },
      SECRET,
      '15m',
    );
    const context = contextWith({}, { token });

    await expect(scopedGuard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
