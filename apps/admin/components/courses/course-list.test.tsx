import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi, it, expect } from 'vitest';
import { CourseList } from './course-list';
import { createCourseAction } from '@/app/(app)/courses/actions';
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/app/(app)/courses/actions', () => ({ createCourseAction: vi.fn() }));
it('creates a course from a title and immutable slug, keeping the form after failure', async () => {
  vi.mocked(createCourseAction)
    .mockResolvedValueOnce({ status: 'unauthorized' })
    .mockResolvedValueOnce({ status: 'ok', data: {} });
  render(<CourseList courses={[]} />);
  expect(screen.getByText('从第一门课程开始')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '新建课程' }));
  fireEvent.change(screen.getByLabelText('课程名称'), {
    target: { value: 'New course' },
  });
  fireEvent.change(screen.getByLabelText(/课程标识/), {
    target: { value: 'new-course' },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: '创建课程' })),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('登录已过期');
  expect(screen.getByLabelText('课程名称')).toHaveValue('New course');
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: '创建课程' })),
  );
  expect(createCourseAction).toHaveBeenLastCalledWith({
    title: 'New course',
    slug: 'new-course',
  });
  expect(push).toHaveBeenCalledWith('/courses/new-course');
});
it('shows published and draft versions with current enrollment counts', () => {
  render(
    <CourseList
      courses={[
        {
          slug: 'course',
          title: 'Published',
          published: true,
          hasDraft: false,
          latestPublishedVersion: 2,
          lessonCount: 3,
          activeEnrollments: 7,
        },
        {
          slug: 'draft',
          title: 'Draft',
          published: false,
          hasDraft: true,
          latestPublishedVersion: null,
          lessonCount: 0,
          activeEnrollments: 0,
        },
      ]}
    />,
  );
  expect(screen.getByText('v2')).toBeInTheDocument();
  expect(screen.getByText('7 名在学学员')).toBeInTheDocument();
  expect(screen.getByText('有草稿')).toBeInTheDocument();
});
