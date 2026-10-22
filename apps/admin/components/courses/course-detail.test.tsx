import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi, it, expect, beforeEach } from 'vitest';
import type {
  CourseDraftRead,
  CourseListItem,
} from '@aivirteach/admin-contract';
import { CourseDetail } from './course-detail';
import { courseMutation } from '@/app/(app)/courses/actions';
vi.mock('@/app/(app)/courses/actions', () => ({ courseMutation: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
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
