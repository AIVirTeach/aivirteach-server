import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/api-client', () => ({ apiFetchNoRedirect: vi.fn() }));
import { apiFetchNoRedirect } from '@/lib/api-client';
import { courseMutation, uploadAssetAction } from './actions';
beforeEach(() => vi.resetAllMocks());
describe('safe write actions', () => {
  it('returns unauthorized without redirecting or losing local state', async () => {
    vi.mocked(apiFetchNoRedirect).mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    expect(
      await courseMutation('course', 'draft/lessons/one', 'PATCH', {
        content: { blocks: [] },
      }),
    ).toEqual({ status: 'unauthorized' });
    expect(await uploadAssetAction('course', new FormData())).toEqual({
      status: 'unauthorized',
    });
  });
  it('preserves all publish problems and structured locations', async () => {
    const problems = Array.from({ length: 40 }, (_, i) => `问题 ${i}`);
    const issues = problems.map((message) => ({
      message,
      contentId: 'lesson',
    }));
    vi.mocked(apiFetchNoRedirect).mockResolvedValue(
      Response.json({ message: '无法发布', problems, issues }, { status: 422 }),
    );
    expect(await courseMutation('course', 'publish', 'POST')).toEqual({
      status: 'error',
      message: '无法发布',
      problems,
      issues,
    });
  });
  it('forwards lesson content only without replacing metadata', async () => {
    vi.mocked(apiFetchNoRedirect).mockResolvedValue(
      Response.json({ problems: { errors: [], warnings: [] } }),
    );
    const content = { schemaVersion: 1, blocks: [] };
    await courseMutation('course', 'draft/lessons/one', 'PATCH', { content });
    expect(apiFetchNoRedirect).toHaveBeenCalledWith(
      '/admin/courses/course/draft/lessons/one',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ content }),
      }),
    );
  });
});

it('preserves content validation fields through the action adapter', async () => {
  const validation = {
    errors: [
      {
        level: 'error',
        code: 'invalid-props',
        message: 'Missing label',
        blockId: 'annotated',
        blockIndex: 2,
        fieldPath: ['steps', 1, 'label'],
      },
    ],
    warnings: [],
  };
  vi.mocked(apiFetchNoRedirect).mockResolvedValue(
    Response.json(
      { message: '课时内容无效', problems: ['Missing label'], validation },
      { status: 422 },
    ),
  );
  expect(
    await courseMutation('course', 'draft/lessons/one', 'PATCH', {
      content: {},
    }),
  ).toEqual({
    status: 'error',
    message: '课时内容无效',
    problems: ['Missing label'],
    issues: [],
    validation,
  });
});
