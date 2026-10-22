import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi, it, expect, afterEach } from 'vitest';
import type { DraftLesson, DraftVersion } from '@aivirteach/admin-contract';
import { LessonEditor } from './lesson-editor';
import { courseMutation, uploadAssetAction } from '@/app/(app)/courses/actions';
vi.mock('@/app/(app)/courses/actions', () => ({
  courseMutation: vi.fn(),
  uploadAssetAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const lesson: DraftLesson = {
  id: 'l',
  contentId: 'lesson',
  moduleId: 'm',
  position: 1,
  title: 'First lesson',
  estimatedMinutes: 10,
  objectives: [],
  activityType: 'practice',
  activityPrompt: '',
  activityCompletionType: 'manual',
  assessmentIds: [],
  assessments: [],
  body: '',
  content: { schemaVersion: 1, blocks: [] },
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
      title: 'Module',
      description: '',
      estimatedMinutes: 10,
      lessons: [lesson],
    },
  ],
};
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('retains text on unauthorized, retries the same content, and never hydrates from a save summary', async () => {
  vi.useFakeTimers();
  vi.mocked(courseMutation)
    .mockResolvedValueOnce({ status: 'unauthorized' })
    .mockResolvedValue({
      status: 'ok',
      data: { draft: { modules: [] }, problems: { errors: [], warnings: [] } },
    });
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={lesson}
      moduleTitle="Module"
      initialAssets={[]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
  fireEvent.change(screen.getByLabelText('文字'), {
    target: { value: 'Keep this local paragraph' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(screen.getByText(/登录已过期/)).toBeInTheDocument();
  expect(screen.getByLabelText('文字')).toHaveValue(
    'Keep this local paragraph',
  );
  fireEvent.click(screen.getByRole('button', { name: '重试保存' }));
  await act(async () => {});
  expect(screen.getByText('已保存')).toBeInTheDocument();
  expect(screen.getByLabelText('文字')).toHaveValue(
    'Keep this local paragraph',
  );
  expect(vi.mocked(courseMutation).mock.calls.at(-1)?.[3]).toMatchObject({
    content: {
      schemaVersion: 1,
      blocks: [
        { type: 'paragraph', props: { text: 'Keep this local paragraph' } },
      ],
    },
  });
});
it('duplicates, reorders, deletes, undoes and redoes blocks through the editor controls', () => {
  vi.useFakeTimers();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={lesson}
      moduleTitle="Module"
      initialAssets={[]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  expect(screen.getByText('2 / 300 块')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '第2块上移' }));
  fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
  expect(screen.getByText('1 / 300 块')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(screen.getByText('2 / 300 块')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重做' }));
  expect(screen.getByText('1 / 300 块')).toBeInTheDocument();
});
it('keeps newer image captions and guards departure until overlapping uploads and saves finish', async () => {
  vi.useFakeTimers();
  const resolveUploads: Array<
    (value: Awaited<ReturnType<typeof uploadAssetAction>>) => void
  > = [];
  vi.mocked(uploadAssetAction).mockImplementation(
    () => new Promise((resolve) => resolveUploads.push(resolve)),
  );
  vi.mocked(courseMutation).mockResolvedValue({
    status: 'ok',
    data: { problems: { errors: [], warnings: [] } },
  });
  const images: DraftLesson = {
    ...lesson,
    content: {
      schemaVersion: 1,
      blocks: [
        {
          id: 'image-one',
          type: 'image',
          props: { assetId: '', alt: 'one', caption: 'before' },
        },
        { id: 'image-two', type: 'image', props: { assetId: '', alt: 'two' } },
      ],
    },
  };
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={images}
      moduleTitle="Module"
      initialAssets={[]}
    />,
  );
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
  fireEvent.change(screen.getByLabelText('上传图片'), {
    target: { files: [new File(['x'], 'one.png', { type: 'image/png' })] },
  });
  fireEvent.change(screen.getByLabelText('图片说明'), {
    target: { value: 'Caption edited during upload' },
  });
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
  fireEvent.change(screen.getByLabelText('上传图片'), {
    target: { files: [new File(['x'], 'two.png', { type: 'image/png' })] },
  });
  const asset = (id: string) => ({
    status: 'ok' as const,
    data: {
      id,
      url: `https://example.test/${id}.png`,
      altText: id,
      mimeType: 'image/png',
      createdAt: '',
    },
  });
  await act(async () => resolveUploads[0](asset('first')));
  const blocked = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(blocked);
  expect(blocked.defaultPrevented).toBe(true);
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
  expect(screen.getByLabelText('图片说明')).toHaveValue(
    'Caption edited during upload',
  );
  expect(screen.getByLabelText('课程图片')).toHaveValue('first');
  await act(async () => resolveUploads[1](asset('second')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  const clean = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
});

it('preserves manual selection across a picker remount and saves it after a late upload', async () => {
  vi.useFakeTimers();
  let finish!: (value: Awaited<ReturnType<typeof uploadAssetAction>>) => void;
  vi.mocked(uploadAssetAction).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(courseMutation).mockResolvedValue({
    status: 'ok',
    data: { problems: { errors: [], warnings: [] } },
  });
  const images: DraftLesson = {
    ...lesson,
    content: {
      schemaVersion: 1,
      blocks: [
        { id: 'one', type: 'image', props: { assetId: '', alt: 'one' } },
        { id: 'two', type: 'image', props: { assetId: '', alt: 'two' } },
      ],
    },
  };
  const existing = {
    id: 'existing',
    url: 'https://example.test/existing.png',
    altText: 'Existing',
    mimeType: 'image/png',
    createdAt: '',
  };
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={images}
      moduleTitle="Module"
      initialAssets={[existing]}
    />,
  );
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
  fireEvent.change(screen.getByLabelText('上传图片'), {
    target: { files: [new File(['x'], 'upload.png', { type: 'image/png' })] },
  });
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
  fireEvent.change(screen.getByLabelText('课程图片'), {
    target: { value: 'existing' },
  });
  await act(async () =>
    finish({ status: 'ok', data: { ...existing, id: 'uploaded' } }),
  );
  expect(screen.getByLabelText('课程图片')).toHaveValue('existing');
  expect(
    screen
      .getAllByRole('option')
      .some((option) => option.getAttribute('value') === 'uploaded'),
  ).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(courseMutation).toHaveBeenLastCalledWith(
    'course',
    'draft/lessons/lesson',
    'PATCH',
    {
      content: {
        schemaVersion: 1,
        blocks: [
          {
            id: 'one',
            type: 'image',
            props: { assetId: 'existing', alt: 'one' },
          },
          { id: 'two', type: 'image', props: { assetId: '', alt: 'two' } },
        ],
      },
    },
  );
});
