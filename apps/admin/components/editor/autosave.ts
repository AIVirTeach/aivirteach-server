import type { ActionResult } from '@/lib/action-result';
export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';
export function createAutosave<T, R>(
  save: (value: T) => Promise<ActionResult<R>>,
  notify: (status: SaveStatus, result?: ActionResult<R>) => void,
  delay = 800,
) {
  let revision = 0;
  let saved = 0;
  let running = false;
  let disposed = false;
  let value: T;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function flush() {
    clearTimeout(timer);
    if (running || saved === revision || disposed) return;
    running = true;
    const sent = revision;
    const snapshot = value;
    notify('saving');
    let result: ActionResult<R>;
    try {
      result = await save(snapshot);
    } catch {
      result = {
        status: 'error',
        message: '保存失败，请重试',
        problems: [],
        issues: [],
      };
    }
    running = false;
    if (disposed) return;
    if (result.status !== 'ok') {
      notify('failed', result);
      return;
    }
    saved = sent;
    if (revision !== sent) {
      notify('dirty');
      void flush();
    } else notify('saved', result);
  }
  return {
    edit(next: T) {
      value = next;
      revision++;
      clearTimeout(timer);
      notify(running ? 'saving' : 'dirty');
      if (!running) timer = setTimeout(() => void flush(), delay);
    },
    retry: flush,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
