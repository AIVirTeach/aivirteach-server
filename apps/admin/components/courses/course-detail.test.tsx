import { Suspense, startTransition, use, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi, it, expect, beforeEach } from 'vitest';
import type {
  CourseDraftRead,
  CourseListItem,
} from '@aivirteach/admin-contract';
import { CourseDetail } from './course-detail';
import { courseMutation } from '@/app/(app)/courses/actions';
vi.mock('@/app/(app)/courses/actions', () => ({ courseMutation: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const course: CourseListItem = {
  slug: 'test',
  title: 'Test course',
  hasDraft: true,
  published: false,
  latestPublishedVersion: null,
  lessonCount: 0,
  activeEnrollments: 0,
};
const draft: CourseDraftRead = {
  id: 'draft',
  courseId: 'course',
  version: 1,
  publishedAt: null,
  createdAt: '',
  meta: null,
  modules: [],
  welcome: null,
  effectiveMeta: {
    title: 'Test course',
    shortTitle: null,
    category: 'Engineering',
    description: 'Existing description',
    level: 'Beginner',
    language: 'zh',
    tags: [],
    outcomes: [],
    requirements: [],
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  refresh.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
it('locks all editable fields while publishing and unlocks on transport failure', async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(courseMutation).mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  render(<CourseDetail course={course} draft={draft} />);
  expect(screen.getByLabelText('课程简介')).toHaveValue('Existing description');
  fireEvent.click(screen.getByRole('button', { name: '发布课程' }));
  expect(screen.getByLabelText('课程名称')).toBeDisabled();
  expect(screen.getByLabelText('模块名称')).toBeDisabled();
  await act(async () => reject(new Error('connection dropped')));
  expect(screen.getByLabelText('课程名称')).toBeEnabled();
  expect(screen.getByRole('button', { name: '发布课程' })).toBeEnabled();
  expect(screen.getByText(/操作可能已完成/)).toBeInTheDocument();
});
it('requires metadata to be saved before publishing or discarding', () => {
  render(<CourseDetail course={course} draft={draft} />);
  fireEvent.change(screen.getByLabelText('课程名称'), {
    target: { value: 'Unsaved title' },
  });
  expect(screen.getByRole('button', { name: '发布课程' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '丢弃草稿' })).toBeDisabled();
});

it('keeps metadata, publish and departure locked until refreshed data commits', async () => {
  vi.mocked(courseMutation).mockResolvedValue({ status: 'ok', data: {} });
  let finishRefresh!: (value: CourseDraftRead) => void;
  const pending = new Promise<CourseDraftRead>((resolve) => {
    finishRefresh = resolve;
  });
  function Page({
    data,
  }: {
    data: CourseDraftRead | Promise<CourseDraftRead>;
  }) {
    const current = data instanceof Promise ? use(data) : data;
    return <CourseDetail course={course} draft={current} />;
  }
  function Route() {
    const [data, setData] = useState<
      CourseDraftRead | Promise<CourseDraftRead>
    >(draft);
    refresh.mockImplementation(() => startTransition(() => setData(pending)));
    return (
      <Suspense fallback={<p>Loading route</p>}>
        <Page data={data} />
      </Suspense>
    );
  }
  render(<Route />);
  fireEvent.change(screen.getByLabelText('课程名称'), {
    target: { value: 'Saved title' },
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('课程名称')).toBeDisabled();
  expect(screen.getByRole('button', { name: '发布课程' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '丢弃草稿' })).toBeDisabled();
  const pendingUnload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(pendingUnload);
  expect(pendingUnload.defaultPrevented).toBe(true);
  await act(async () =>
    finishRefresh({
      ...draft,
      effectiveMeta: { ...draft.effectiveMeta, title: 'Saved title' },
    }),
  );
  expect(screen.getByLabelText('课程名称')).toHaveValue('Saved title');
  expect(screen.getByLabelText('课程名称')).toBeEnabled();
  expect(screen.getByRole('button', { name: '发布课程' })).toBeEnabled();
  const cleanUnload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(cleanUnload);
  expect(cleanUnload.defaultPrevented).toBe(false);
  fireEvent.change(screen.getByLabelText('课程名称'), {
    target: { value: 'Next edit' },
  });
  expect(screen.getByLabelText('课程名称')).toHaveValue('Next edit');
  expect(screen.getByRole('button', { name: '发布课程' })).toBeDisabled();
});
