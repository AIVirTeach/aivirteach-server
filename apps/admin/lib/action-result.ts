import type {
  PublishIssue,
  LessonSaveResult,
} from '@aivirteach/admin-contract';
export type ActionResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'unauthorized' }
  | {
      status: 'error';
      message: string;
      problems: string[];
      issues: PublishIssue[];
      validation?: LessonSaveResult['problems'];
    };
export function resultMessage(
  result: Exclude<ActionResult<unknown>, { status: 'ok' }>,
): string {
  return result.status === 'unauthorized'
    ? '登录已过期，请在新标签页重新登录后重试'
    : result.message;
}

export async function settleAction<T>(
  pending: Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await pending;
  } catch {
    return {
      status: 'error',
      message: '未收到服务器结果，操作可能已完成。请在新标签页核实后再重试。',
      problems: [],
      issues: [],
    };
  }
}
