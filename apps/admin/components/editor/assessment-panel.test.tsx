import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { vi, it, expect } from 'vitest';
import { AssessmentPanel } from './assessment-panel';
import { courseMutation } from '@/app/(app)/courses/actions';
vi.mock('@/app/(app)/courses/actions', () => ({ courseMutation: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
it('creates a new assessment and updates an existing assessment', async () => {
  vi.mocked(courseMutation).mockResolvedValue({ status: 'ok', data: {} });
  const onDirty = vi.fn();
  render(
    <AssessmentPanel
      slug="course"
      contentId="lesson"
      assessments={[
        {
          id: 'assessment',
          lessonId: 'lesson',
          type: 'knowledge',
          question: 'Original question',
          options: ['A'],
          clientCriteria: [],
          expectedResult: null,
          successCriteria: [],
          commonFailures: [],
        },
      ]}
      onDirty={onDirty}
    />,
  );
  const existing = screen
    .getByText('测评 1 · Original question')
    .closest('details')!;
  existing.open = true;
  fireEvent.change(within(existing).getByLabelText('题干'), {
    target: { value: 'Updated question' },
  });
  await act(async () =>
    fireEvent.click(within(existing).getByRole('button', { name: '保存' })),
  );
  expect(courseMutation).toHaveBeenLastCalledWith(
    'course',
    'draft/assessments/assessment',
    'PATCH',
    expect.objectContaining({ question: 'Updated question' }),
  );
  const added = screen.getByText('＋ 添加测评').closest('details')!;
  added.open = true;
  fireEvent.change(within(added).getByLabelText('题干'), {
    target: { value: 'New question' },
  });
  await act(async () =>
    fireEvent.click(within(added).getByRole('button', { name: '创建测评' })),
  );
  expect(courseMutation).toHaveBeenLastCalledWith(
    'course',
    'draft/lessons/lesson/assessments',
    'POST',
    expect.objectContaining({ type: 'knowledge', question: 'New question' }),
  );
  expect(onDirty).toHaveBeenCalledWith('new-assessment', false);
});
