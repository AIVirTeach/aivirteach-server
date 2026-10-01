import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Env } from '../config/env';
import { AdminApiTokenGuard } from './admin-api-token.guard';

const ENV_STUB = {
  ADMIN_API_TOKEN: 't'.repeat(32),
} as Env;

function contextWith(authorization?: string): ExecutionContext {
  const request = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AdminApiTokenGuard', () => {
  const guard = new AdminApiTokenGuard(ENV_STUB);

  it('正确令牌放行', () => {
    expect(
      guard.canActivate(contextWith(`Bearer ${ENV_STUB.ADMIN_API_TOKEN}`)),
    ).toBe(true);
  });

  it.each([
    ['无 authorization 头', undefined],
    ['非 Bearer scheme', 'Basic xxx'],
    ['空 Bearer 令牌', 'Bearer '],
    ['短令牌', 'Bearer short'],
    ['等长错误令牌', `Bearer ${'x'.repeat(32)}`],
  ])('%s 时抛 UnauthorizedException', (_label, authorization) => {
    try {
      guard.canActivate(contextWith(authorization));
      throw new Error('预期拒绝请求');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
    }
  });
});
