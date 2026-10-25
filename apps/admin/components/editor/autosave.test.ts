import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAutosave } from './autosave';
import type { ActionResult } from '@/lib/action-result';
const report = { errors: [], warnings: [] };
const ready = (revision: number, value: string) => ({
  kind: 'ready' as const,
  revision,
  value,
  report,
});
const blocked = (revision: number) => ({
  kind: 'blocked' as const,
  revision,
  report,
});
const ok = { status: 'ok' as const, data: 'ok' };
function deferred() {
  let resolve!: (result: ActionResult<string>) => void;
  const promise = new Promise<ActionResult<string>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
describe('serialized autosave', () => {
  it('debounces edits and sends only the latest revision', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const save = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(ok);
    const notify = vi.fn();
    const queue = createAutosave(save, notify);
    queue.stage(ready(1, 'a'));
    queue.stage(ready(2, 'b'));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledExactlyOnceWith('b');
    queue.stage(ready(3, 'c'));
    first.resolve(ok);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenLastCalledWith('c');
    expect(
      notify.mock.calls.filter(([notice]) => notice.status === 'saved'),
    ).toEqual([[{ status: 'saved', revision: 3, result: ok }]]);
  });
  it.each(['ok', 'error'] as const)(
    'does not replace blocked edits with an old %s reply',
    async (status) => {
      vi.useFakeTimers();
      const first = deferred();
      const save = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(ok);
      const notify = vi.fn();
      const queue = createAutosave(save, notify);
      queue.stage(ready(1, 'valid'));
      await vi.advanceTimersByTimeAsync(800);
      queue.stage(blocked(2));
      first.resolve(
        status === 'ok'
          ? ok
          : {
              status: 'error',
              message: 'old failure',
              problems: [],
              issues: [],
            },
      );
      await vi.advanceTimersByTimeAsync(800);
      expect(save).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenLastCalledWith({
        status: 'blocked',
        revision: 2,
      });
      queue.stage(ready(3, 'repaired'));
      await vi.advanceTimersByTimeAsync(800);
      expect(save).toHaveBeenLastCalledWith('repaired');
      expect(notify).toHaveBeenLastCalledWith({
        status: 'saved',
        revision: 3,
        result: ok,
      });
    },
  );
  it('continues a newer valid revision after an older request fails', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const save = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(ok);
    const notify = vi.fn();
    const queue = createAutosave(save, notify);
    queue.stage(ready(1, 'old'));
    await vi.advanceTimersByTimeAsync(800);
    queue.stage(ready(2, 'latest'));
    first.resolve({ status: 'unauthorized' });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenLastCalledWith('latest');
    expect(notify).toHaveBeenLastCalledWith({
      status: 'saved',
      revision: 2,
      result: ok,
    });
  });
  it('cancels a pending valid revision when a newer one is blocked', async () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const queue = createAutosave(save, vi.fn());
    queue.stage(ready(1, 'valid'));
    queue.stage(blocked(2));
    await vi.advanceTimersByTimeAsync(800);
    await queue.retry();
    expect(save).not.toHaveBeenCalled();
  });
  it('retains current unauthorized edits for retry and ignores replies after dispose', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const save = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unauthorized' })
      .mockReturnValueOnce(pending.promise);
    const notify = vi.fn();
    const queue = createAutosave(save, notify);
    queue.stage(ready(1, 'local'));
    await vi.advanceTimersByTimeAsync(800);
    expect(notify).toHaveBeenLastCalledWith({
      status: 'failed',
      revision: 1,
      result: { status: 'unauthorized' },
    });
    const retry = queue.retry();
    expect(save).toHaveBeenLastCalledWith('local');
    queue.dispose();
    notify.mockClear();
    pending.resolve(ok);
    await retry;
    expect(notify).not.toHaveBeenCalled();
  });
  it('keeps a current server validation rejection without looping', async () => {
    vi.useFakeTimers();
    const failure = {
      status: 'error' as const,
      message: 'Invalid image',
      problems: ['Invalid image'],
      issues: [],
      validation: {
        errors: [
          {
            code: 'unknown-asset',
            level: 'error' as const,
            message: 'Invalid image',
            blockIndex: 0,
            fieldPath: ['assetId'],
          },
        ],
        warnings: [],
      },
    };
    const save = vi.fn().mockResolvedValue(failure);
    const notify = vi.fn();
    const queue = createAutosave(save, notify);
    queue.stage(ready(1, 'image'));
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith({
      status: 'failed',
      revision: 1,
      result: failure,
    });
    await queue.retry();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
