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
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
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
        {
          id: 'two',
          type: 'image',
          props: { assetId: 'existing', alt: 'two' },
        },
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
          {
            id: 'two',
            type: 'image',
            props: { assetId: 'existing', alt: 'two' },
          },
        ],
      },
    },
  );
});

it('blocks invalid local content without sending it and resumes after repair', async () => {
  vi.useFakeTimers();
  vi.mocked(courseMutation).mockResolvedValue({
    status: 'ok',
    data: { problems: { errors: [], warnings: [] } },
  });
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={lesson}
      moduleTitle="Module"
      initialAssets={[
        {
          id: 'asset',
          url: '/image.png',
          altText: 'Picture',
          mimeType: 'image/png',
          createdAt: '',
        },
      ]}
    />,
  );
  fireEvent.change(screen.getByLabelText('内容类型'), {
    target: { value: 'image' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(courseMutation).not.toHaveBeenCalled();
  expect(screen.getByText(/尚未保存/)).toBeInTheDocument();
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.change(screen.getByLabelText('课程图片'), {
    target: { value: 'asset' },
  });
  fireEvent.change(screen.getByLabelText('替代文字'), {
    target: { value: 'A picture' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(courseMutation).toHaveBeenCalledTimes(1);
  expect(screen.getByText('已保存')).toBeInTheDocument();
});

it('opens and focuses a nested invalid field only when its problem is clicked', () => {
  vi.useFakeTimers();
  const nested = {
    ...lesson,
    content: {
      schemaVersion: 1,
      blocks: [
        {
          id: 'code',
          type: 'annotatedCode',
          props: { steps: [{ label: '', code: 'ok', terms: [] }] },
        },
      ],
    },
  };
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={nested}
      moduleTitle="Module"
      initialAssets={[]}
    />,
  );
  expect(screen.queryByLabelText('步骤 1 · 标签')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /props.steps.0.label/ }));
  const input = screen.getByLabelText('步骤 1 · 标签');
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAttribute('data-field-path', '["steps",0,"label"]');
  expect(
    document.getElementById(input.getAttribute('aria-describedby')!),
  ).toHaveTextContent('批注代码步骤标签不能为空');
  fireEvent.change(input, { target: { value: 'Fixed label' } });
  expect(input).toHaveFocus();
});

it('focuses a table cell and an image picker through the same field path contract', () => {
  vi.useFakeTimers();
  const content: DraftLesson['content'] = {
    schemaVersion: 1,
    blocks: [
      {
        id: 'table',
        type: 'table',
        props: { columns: ['A'], rows: [['x'.repeat(301)]] },
      },
      {
        id: 'image',
        type: 'image',
        props: { assetId: 'missing', alt: 'Image' },
      },
    ],
  };
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={{ ...lesson, content }}
      moduleTitle="Module"
      initialAssets={[]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /props.rows.0.0/ }));
  expect(screen.getByLabelText('单元格 1-1')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: /图片资源不存在/ }));
  expect(screen.getByLabelText('课程图片')).toHaveFocus();
  expect(screen.getByLabelText('课程图片')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
});

it('keeps invalid initial envelopes blocked instead of overwriting them with empty content', async () => {
  vi.useFakeTimers();
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={{ ...lesson, content: null }}
      moduleTitle="Module"
      initialAssets={[]}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('初始正文格式无效');
  expect(screen.getByRole('button', { name: '添加内容' })).toBeDisabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(courseMutation).not.toHaveBeenCalled();
});

it('keeps duplicate block ids at the indexed problem summary without selecting an arbitrary duplicate', () => {
  vi.useFakeTimers();
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={{
        ...lesson,
        content: {
          schemaVersion: 1,
          blocks: [
            { id: 'same', type: 'paragraph', props: { text: 'first' } },
            { id: 'same', type: 'paragraph', props: { text: 'second' } },
          ],
        },
      }}
      moduleTitle="Module"
      initialAssets={[]}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: /第 2 块：内容块 id 重复/ }),
  );
  expect(screen.getByRole('region', { name: '课时内容问题' })).toHaveFocus();
  expect(screen.queryByLabelText('文字')).not.toBeInTheDocument();
});

it.each(['ok', 'error'] as const)(
  'keeps a newer invalid revision when an older save returns %s',
  async (status) => {
    vi.useFakeTimers();
    let finish!: (value: Awaited<ReturnType<typeof courseMutation>>) => void;
    vi.mocked(courseMutation).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
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
      target: { value: 'valid' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    fireEvent.change(screen.getByLabelText('内容类型'), {
      target: { value: 'image' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
    await act(async () => {
      finish(
        status === 'ok'
          ? { status: 'ok', data: { problems: { errors: [], warnings: [] } } }
          : {
              status: 'error',
              message: 'obsolete failure',
              problems: [],
              issues: [],
            },
      );
    });
    expect(screen.getByText(/尚未保存/)).toBeInTheDocument();
    expect(screen.queryByText('已保存')).not.toBeInTheDocument();
    expect(screen.queryByText('obsolete failure')).not.toBeInTheDocument();
    expect(courseMutation).toHaveBeenCalledTimes(1);
  },
);

it('keeps server-only validation attached to the current revision and resumes after editing', async () => {
  vi.useFakeTimers();
  vi.mocked(courseMutation)
    .mockResolvedValueOnce({
      status: 'error',
      message: '服务器拒绝图片',
      problems: ['图片已删除'],
      issues: [],
      validation: {
        errors: [
          {
            level: 'error',
            code: 'unknown-asset',
            message: '图片已删除',
            blockId: 'image',
            blockIndex: 0,
            fieldPath: ['assetId'],
          },
        ],
        warnings: [],
      },
    })
    .mockResolvedValue({
      status: 'ok',
      data: { problems: { errors: [], warnings: [] } },
    });
  const image = {
    ...lesson,
    content: {
      schemaVersion: 1,
      blocks: [
        {
          id: 'image',
          type: 'image',
          props: { assetId: 'asset', alt: 'original' },
        },
      ],
    },
  };
  render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={image}
      moduleTitle="Module"
      initialAssets={[
        {
          id: 'asset',
          url: '/image.png',
          altText: 'Picture',
          mimeType: 'image/png',
          createdAt: '',
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  fireEvent.change(screen.getByLabelText('替代文字'), {
    target: { value: 'new alt' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  fireEvent.click(screen.getByRole('button', { name: /图片已删除/ }));
  expect(screen.getByLabelText('课程图片')).toHaveFocus();
  expect(
    screen.queryByRole('button', { name: '重试保存' }),
  ).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(courseMutation).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('替代文字'), {
    target: { value: 'fixed again' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(
    screen.queryByRole('button', { name: /图片已删除/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText('已保存')).toBeInTheDocument();
});

it('revalidates unchanged local content when the authoritative asset list changes', async () => {
  vi.useFakeTimers();
  vi.mocked(courseMutation).mockResolvedValue({
    status: 'ok',
    data: { problems: { errors: [], warnings: [] } },
  });
  const image = {
    ...lesson,
    content: {
      schemaVersion: 1,
      blocks: [
        {
          id: 'image',
          type: 'image',
          props: { assetId: 'asset', alt: 'Picture' },
        },
      ],
    },
  };
  const props = { slug: 'course', draft, lesson: image, moduleTitle: 'Module' };
  const { rerender } = render(<LessonEditor {...props} initialAssets={[]} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(courseMutation).not.toHaveBeenCalled();
  rerender(
    <LessonEditor
      {...props}
      initialAssets={[
        {
          id: 'asset',
          url: '/image.png',
          altText: 'Picture',
          mimeType: 'image/png',
          createdAt: '',
        },
      ]}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(courseMutation).toHaveBeenCalledTimes(1);
  expect(screen.getByText('已保存')).toBeInTheDocument();
});

it('retains server validation and local edits when metadata refresh recreates equivalent props', async () => {
  vi.useFakeTimers();
  const validation = {
    errors: [
      {
        level: 'error' as const,
        code: 'unknown-asset',
        message: '服务端图片已删除',
        blockId: 'image',
        blockIndex: 0,
        fieldPath: ['assetId'],
      },
    ],
    warnings: [],
  };
  vi.mocked(courseMutation).mockResolvedValue({
    status: 'error',
    message: '无法保存',
    problems: ['服务端图片已删除'],
    issues: [],
    validation,
  });
  const content = {
    schemaVersion: 1,
    blocks: [
      {
        id: 'image',
        type: 'image',
        props: { assetId: 'asset', alt: 'server original' },
      },
    ],
  };
  const image = { ...lesson, content };
  const asset = {
    id: 'asset',
    url: '/image.png',
    altText: 'Picture',
    mimeType: 'image/png',
    createdAt: '',
  };
  const { rerender } = render(
    <LessonEditor
      slug="course"
      draft={draft}
      lesson={image}
      moduleTitle="Module"
      initialAssets={[asset]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  fireEvent.change(screen.getByLabelText('替代文字'), {
    target: { value: 'unsaved local alt' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(courseMutation).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('button', { name: /服务端图片已删除/ }),
  ).toBeInTheDocument();
  rerender(
    <LessonEditor
      slug="course"
      draft={{ ...draft }}
      lesson={{
        ...image,
        title: 'Refreshed title',
        content: structuredClone(content),
      }}
      moduleTitle="Module"
      initialAssets={[{ ...asset, altText: 'Refreshed asset title' }]}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(courseMutation).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('button', { name: /服务端图片已删除/ }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('替代文字')).toHaveValue('unsaved local alt');
});

it('retains unconfirmed uploads across stale refreshes, then reflects deletion after server confirmation', async () => {
  vi.useFakeTimers();
  const uploaded = {
    id: 'uploaded',
    url: '/uploaded.png',
    altText: 'Uploaded',
    mimeType: 'image/png',
    createdAt: '',
  };
  vi.mocked(uploadAssetAction).mockResolvedValue({
    status: 'ok',
    data: uploaded,
  });
  vi.mocked(courseMutation).mockResolvedValue({
    status: 'ok',
    data: { problems: { errors: [], warnings: [] } },
  });
  const image = {
    ...lesson,
    content: {
      schemaVersion: 1,
      blocks: [
        { id: 'image', type: 'image', props: { assetId: '', alt: 'Picture' } },
      ],
    },
  };
  const props = { slug: 'course', draft, lesson: image, moduleTitle: 'Module' };
  const { rerender } = render(<LessonEditor {...props} initialAssets={[]} />);
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  await act(async () => {
    fireEvent.change(screen.getByLabelText('上传图片'), {
      target: { files: [new File(['x'], 'upload.png', { type: 'image/png' })] },
    });
  });
  expect(screen.getByLabelText('课程图片')).toHaveValue('uploaded');
  rerender(
    <LessonEditor
      {...props}
      lesson={{ ...image, title: 'Stale metadata refresh' }}
      initialAssets={[]}
    />,
  );
  expect(screen.getByLabelText('课程图片')).toHaveValue('uploaded');
  expect(
    screen.queryByRole('button', { name: /图片资源不存在/ }),
  ).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(courseMutation).toHaveBeenCalledTimes(1);
  expect(screen.getByText('已保存')).toBeInTheDocument();

  rerender(<LessonEditor {...props} initialAssets={[{ ...uploaded }]} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(screen.getByLabelText('课程图片')).toHaveValue('uploaded');
  expect(courseMutation).toHaveBeenCalledTimes(1);
  rerender(<LessonEditor {...props} initialAssets={[]} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(
    screen.getByRole('button', { name: /图片资源不存在：uploaded/ }),
  ).toBeInTheDocument();
  expect(screen.getByText(/尚未保存/)).toBeInTheDocument();
  expect(
    screen.queryByRole('option', { name: 'Uploaded' }),
  ).not.toBeInTheDocument();
  expect(courseMutation).toHaveBeenCalledTimes(1);
});
