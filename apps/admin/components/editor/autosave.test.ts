import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAutosave } from './autosave';
import type { ActionResult } from '@/lib/action-result';
afterEach(() => vi.useRealTimers());
describe('serialized autosave', () => {
  it('debounces edits and sends the latest revision after an in-flight save', async () => {
    vi.useFakeTimers();
    const resolvers: ((r: ActionResult<string>) => void)[] = [];
    const save = vi.fn(
      (_: string) =>
        new Promise<ActionResult<string>>((resolve) => resolvers.push(resolve)),
    );
    const notify = vi.fn();
    const queue = createAutosave(save, notify);
    queue.edit('a');
    queue.edit('b');
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledWith('b');
    queue.edit('c');
    expect(save).toHaveBeenCalledTimes(1);
    resolvers[0]({ status: 'ok', data: 'ok' });
    await Promise.resolve();
    expect(save).toHaveBeenLastCalledWith('c');
    expect(notify).not.toHaveBeenCalledWith('saved', expect.anything());
    resolvers[1]({ status: 'ok', data: 'ok' });
    await Promise.resolve();
    expect(notify).toHaveBeenLastCalledWith('saved', {
      status: 'ok',
      data: 'ok',
    });
    queue.dispose();
  });
  it('keeps the unsaved revision after unauthorized and retries it', async () => {
    vi.useFakeTimers();
    const save = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unauthorized' })
      .mockResolvedValueOnce({ status: 'ok', data: null });
    const notify = vi.fn();
    const queue = createAutosave(save, notify);
    queue.edit('local content');
    await vi.advanceTimersByTimeAsync(800);
    expect(notify).toHaveBeenLastCalledWith('failed', {
      status: 'unauthorized',
    });
    await queue.retry();
    expect(save).toHaveBeenLastCalledWith('local content');
    expect(notify).toHaveBeenLastCalledWith('saved', {
      status: 'ok',
      data: null,
    });
  });
});
