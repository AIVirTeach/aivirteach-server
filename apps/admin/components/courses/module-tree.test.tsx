import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { vi, it, expect } from 'vitest';
import type { DraftVersion } from '@aivirteach/admin-contract';
import { ModuleTree } from './module-tree';
import { courseMutation } from '@/app/(app)/courses/actions';
vi.mock('@/app/(app)/courses/actions', () => ({ courseMutation: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const lesson = {
  id: 'l',
  contentId: 'first',
  moduleId: 'm',
  position: 1,
  title: 'First',
  estimatedMinutes: 10,
  objectives: [],
  activityType: 'practice',
  activityPrompt: '',
  activityCompletionType: 'manual',
  assessmentIds: [],
  assessments: [],
  body: '',
  content: null,
};
const draft: DraftVersion = {
  id: 'd',
  courseId: 'c',
  version: 1,
  publishedAt: null,
  createdAt: '',
  meta: null,
  welcome: null,
  modules: [
    {
      id: 'm',
      courseVersionId: 'd',
      position: 1,
      title: 'One',
      description: 'desc',
      estimatedMinutes: 20,
      lessons: [
        lesson,
        {
          ...lesson,
          id: 'l2',
          contentId: 'second',
          title: 'Second',
          position: 2,
        },
      ],
    },
    {
      id: 'm2',
      courseVersionId: 'd',
      position: 2,
      title: 'Two',
      description: '',
      estimatedMinutes: 10,
      lessons: [],
    },
  ],
};
it('reorders complete module and lesson permutations, deletes with confirmation', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(courseMutation).mockResolvedValue({ status: 'ok', data: {} });
  render(
    <ModuleTree
      slug="course"
      draft={draft}
      onDirty={() => vi.fn()}
      locked={false}
    />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Two模块上移' })),
  );
  expect(courseMutation).toHaveBeenLastCalledWith(
    'course',
    'draft/order',
    'PUT',
    {
      modules: [
        { id: 'm2', lessons: [] },
        { id: 'm', lessons: ['first', 'second'] },
      ],
    },
  );
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Second课时上移' })),
  );
  expect(courseMutation).toHaveBeenLastCalledWith(
    'course',
    'draft/order',
    'PUT',
    {
      modules: [
        { id: 'm', lessons: ['second', 'first'] },
        { id: 'm2', lessons: [] },
      ],
    },
  );
  await act(async () =>
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]),
  );
  expect(courseMutation).toHaveBeenLastCalledWith(
    'course',
    'draft/lessons/first',
    'DELETE',
    undefined,
  );
});
it('creates modules and lessons with required descriptions, minutes and activity defaults', async () => {
  vi.mocked(courseMutation).mockResolvedValue({ status: 'ok', data: {} });
  render(
    <ModuleTree
      slug="course"
      draft={draft}
      onDirty={() => vi.fn()}
      locked={false}
    />,
  );
  const moduleDetails = screen.getByText('＋ 添加模块').closest('details')!;
  moduleDetails.open = true;
  const module = within(moduleDetails);
  fireEvent.change(module.getByLabelText('模块名称'), {
    target: { value: 'New module' },
  });
  fireEvent.change(module.getByLabelText('模块说明'), {
    target: { value: 'New description' },
  });
  await act(async () =>
    fireEvent.click(module.getByRole('button', { name: '创建模块' })),
  );
  expect(courseMutation).toHaveBeenLastCalledWith(
    'course',
    'draft/modules',
    'POST',
    {
      title: 'New module',
      description: 'New description',
      estimatedMinutes: 30,
    },
  );
  const lessonDetails = screen
    .getAllByText('＋ 添加课时')[0]
    .closest('details')!;
  lessonDetails.open = true;
  const fields = within(lessonDetails);
  fireEvent.change(fields.getByLabelText('课时名称'), {
    target: { value: 'New lesson' },
  });
  fireEvent.change(fields.getByLabelText('课时标识'), {
    target: { value: 'new-lesson' },
  });
  await act(async () =>
    fireEvent.click(fields.getByRole('button', { name: '创建课时' })),
  );
  expect(courseMutation).toHaveBeenLastCalledWith(
    'course',
    'draft/modules/m/lessons',
    'POST',
    expect.objectContaining({
      title: 'New lesson',
      contentId: 'new-lesson',
      estimatedMinutes: 10,
      activity: { type: 'practice', prompt: '', completionType: 'manual' },
      content: { schemaVersion: 1, blocks: [] },
    }),
  );
});
