import type { ValidationReport } from '@aivirteach/lesson-blocks';
import type { ActionResult } from '@/lib/action-result';

export type SaveStatus =
  'idle' | 'blocked' | 'dirty' | 'saving' | 'saved' | 'failed';
export type SaveCandidate<T> =
  | { kind: 'blocked'; revision: number; report: ValidationReport }
  | { kind: 'ready'; revision: number; value: T; report: ValidationReport };
export type SaveNotice<R> =
  | { status: 'blocked' | 'dirty' | 'saving'; revision: number }
  | {
      status: 'saved';
      revision: number;
      result: Extract<ActionResult<R>, { status: 'ok' }>;
    }
  | {
      status: 'failed';
      revision: number;
      result: Exclude<ActionResult<R>, { status: 'ok' }>;
    };

export function createAutosave<T, R>(
  save: (value: T) => Promise<ActionResult<R>>,
  notify: (notice: SaveNotice<R>) => void,
  delay = 800,
) {
  let latest: SaveCandidate<T> | undefined;
  let saved = 0;
  let rejected: number | undefined;
  let running = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function flush() {
    clearTimeout(timer);
    if (
      running ||
      disposed ||
      !latest ||
      latest.kind === 'blocked' ||
      latest.revision === saved ||
      latest.revision === rejected
    )
      return;
    running = true;
    const sent = latest;
    notify({ status: 'saving', revision: sent.revision });
    let result: ActionResult<R>;
    try {
      result = await save(sent.value);
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
    if (result.status === 'ok') saved = sent.revision;
    if (latest.revision !== sent.revision) {
      if (latest.kind === 'ready') void flush();
      return;
    }
    if (result.status === 'ok') {
      notify({ status: 'saved', revision: sent.revision, result });
    } else {
      if (result.status === 'error' && result.validation?.errors.length)
        rejected = sent.revision;
      notify({ status: 'failed', revision: sent.revision, result });
    }
  }
  return {
    stage(candidate: SaveCandidate<T>) {
      if (disposed || (latest && candidate.revision <= latest.revision)) return;
      latest = candidate;
      clearTimeout(timer);
      notify({
        status: candidate.kind === 'blocked' ? 'blocked' : 'dirty',
        revision: candidate.revision,
      });
      if (candidate.kind === 'ready' && !running)
        timer = setTimeout(() => void flush(), delay);
    },
    retry: flush,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
