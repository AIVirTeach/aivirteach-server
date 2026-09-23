import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { WorkspaceIdleSweepInterceptor } from './workspace-idle-sweep.interceptor';

function buildContext(): ExecutionContext {
  return {} as ExecutionContext;
}

function buildHandler(): CallHandler {
  return { handle: () => of('response') };
}

describe('WorkspaceIdleSweepInterceptor', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('放行请求，不等待 sweepIdle 完成', async () => {
    const sweepIdle = jest.fn().mockReturnValue(new Promise(() => {})); // 故意挂起
    const interceptor = new WorkspaceIdleSweepInterceptor({ sweepIdle } as any);

    const result = await interceptor.intercept(buildContext(), buildHandler()).toPromise();

    expect(result).toBe('response');
  });

  it('距上次 sweep 超过 60 秒时触发 sweepIdle', () => {
    jest.useFakeTimers().setSystemTime(0);
    const sweepIdle = jest.fn().mockResolvedValue(undefined);
    const interceptor = new WorkspaceIdleSweepInterceptor({ sweepIdle } as any);

    interceptor.intercept(buildContext(), buildHandler());

    expect(sweepIdle).toHaveBeenCalledTimes(1);
  });

  it('60 秒内的后续请求不重复触发 sweepIdle', () => {
    jest.useFakeTimers().setSystemTime(0);
    const sweepIdle = jest.fn().mockResolvedValue(undefined);
    const interceptor = new WorkspaceIdleSweepInterceptor({ sweepIdle } as any);

    interceptor.intercept(buildContext(), buildHandler());
    jest.setSystemTime(30_000);
    interceptor.intercept(buildContext(), buildHandler());

    expect(sweepIdle).toHaveBeenCalledTimes(1);
  });

  it('超过 60 秒节流窗口后再次触发', () => {
    jest.useFakeTimers().setSystemTime(0);
    const sweepIdle = jest.fn().mockResolvedValue(undefined);
    const interceptor = new WorkspaceIdleSweepInterceptor({ sweepIdle } as any);

    interceptor.intercept(buildContext(), buildHandler());
    jest.setSystemTime(60_001);
    interceptor.intercept(buildContext(), buildHandler());

    expect(sweepIdle).toHaveBeenCalledTimes(2);
  });
});
