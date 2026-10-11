import { of } from 'rxjs';
import {
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import type { WorkspaceService } from './workspace.service';
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
    const sweepResets = jest.fn().mockResolvedValue(undefined);
    const interceptor = new WorkspaceIdleSweepInterceptor({
      sweepIdle,
      sweepResets,
    } as unknown as WorkspaceService);

    const result = await interceptor
      .intercept(buildContext(), buildHandler())
      .toPromise();

    expect(result).toBe('response');
    expect(sweepResets).toHaveBeenCalledTimes(1);
  });

  it('距上次 sweep 超过 60 秒时触发 sweepIdle', () => {
    jest.useFakeTimers().setSystemTime(0);
    const sweepIdle = jest.fn().mockResolvedValue(undefined);
    const sweepResets = jest.fn().mockResolvedValue(undefined);
    const interceptor = new WorkspaceIdleSweepInterceptor({
      sweepIdle,
      sweepResets,
    } as unknown as WorkspaceService);

    interceptor.intercept(buildContext(), buildHandler());

    expect(sweepIdle).toHaveBeenCalledTimes(1);
    expect(sweepResets).toHaveBeenCalledTimes(1);
  });

  it('60 秒内的后续请求不重复触发 sweepIdle', () => {
    jest.useFakeTimers().setSystemTime(0);
    const sweepIdle = jest.fn().mockResolvedValue(undefined);
    const sweepResets = jest.fn().mockResolvedValue(undefined);
    const interceptor = new WorkspaceIdleSweepInterceptor({
      sweepIdle,
      sweepResets,
    } as unknown as WorkspaceService);

    interceptor.intercept(buildContext(), buildHandler());
    jest.setSystemTime(30_000);
    interceptor.intercept(buildContext(), buildHandler());

    expect(sweepIdle).toHaveBeenCalledTimes(1);
    expect(sweepResets).toHaveBeenCalledTimes(1);
  });

  it('超过 60 秒节流窗口后再次触发', () => {
    jest.useFakeTimers().setSystemTime(0);
    const sweepIdle = jest.fn().mockResolvedValue(undefined);
    const sweepResets = jest.fn().mockResolvedValue(undefined);
    const interceptor = new WorkspaceIdleSweepInterceptor({
      sweepIdle,
      sweepResets,
    } as unknown as WorkspaceService);

    interceptor.intercept(buildContext(), buildHandler());
    jest.setSystemTime(60_001);
    interceptor.intercept(buildContext(), buildHandler());

    expect(sweepIdle).toHaveBeenCalledTimes(2);
    expect(sweepResets).toHaveBeenCalledTimes(2);
  });

  it('后台扫描失败时记录错误，并等待另一项扫描完成', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    let finishReset!: () => void;
    const sweepIdle = jest
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const sweepResets = jest.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        finishReset = resolve;
      }),
    );
    const interceptor = new WorkspaceIdleSweepInterceptor({
      sweepIdle,
      sweepResets,
    } as unknown as WorkspaceService);

    expect(interceptor.intercept(buildContext(), buildHandler())).toBeDefined();
    await Promise.resolve();
    expect(warning).toHaveBeenCalledWith(
      'Idle workspace sweep failed',
      expect.any(Error),
    );
    finishReset();
    await Promise.resolve();
    warning.mockRestore();
  });
});
