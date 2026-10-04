import {
  HttpException,
  HttpStatus,
  Logger,
  type ExecutionContext,
} from '@nestjs/common';
import type { Env } from '../../config/env';
import type { CheckTokenQuota } from '../application/check-token-quota';
import type { TokenQuotaVerdict } from '../domain/token-quota';
import { TokenQuotaGuard } from './token-quota.guard';

function contextFor(userId: string): ExecutionContext {
  const request = { auth: { userId, email: 'u@example.com' } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardWith(
  enforced: boolean,
  execute: (userId: string) => Promise<TokenQuotaVerdict>,
) {
  const calls: string[] = [];
  const check = {
    execute: (userId: string) => {
      calls.push(userId);
      return execute(userId);
    },
  } as unknown as CheckTokenQuota;
  const guard = new TokenQuotaGuard(
    { TOKEN_QUOTA_ENFORCED: enforced } as Env,
    check,
  );
  return { guard, calls };
}

describe('TokenQuotaGuard', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('未开启强制时直接放行，且不查额度', async () => {
    const { guard, calls } = guardWith(false, () =>
      Promise.resolve({ verdict: 'exhausted', balance: 0 }),
    );
    await expect(guard.canActivate(contextFor('u1'))).resolves.toBe(true);
    expect(calls).toEqual([]);
  });

  it('开启强制且额度充足 -> 放行，按 JWT 里的 userId 查询', async () => {
    const { guard, calls } = guardWith(true, () =>
      Promise.resolve({ verdict: 'allowed', balance: 10 }),
    );
    await expect(guard.canActivate(contextFor('u1'))).resolves.toBe(true);
    expect(calls).toEqual(['u1']);
  });

  it('开启强制且额度用尽 -> 429 + TOKEN_QUOTA_EXHAUSTED', async () => {
    const { guard } = guardWith(true, () =>
      Promise.resolve({ verdict: 'exhausted', balance: 0 }),
    );
    const error = await guard
      .canActivate(contextFor('u1'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'TOKEN_QUOTA_EXHAUSTED',
    });
  });

  it('额度检查本身失败 -> fail-open 放行，不能因为计量故障挡住学习', async () => {
    const { guard } = guardWith(true, () =>
      Promise.reject(new Error('db down')),
    );
    await expect(guard.canActivate(contextFor('u1'))).resolves.toBe(true);
    expect(errorLog).toHaveBeenCalled();
  });
});
