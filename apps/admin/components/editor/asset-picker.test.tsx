import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi, it, expect } from 'vitest';
import { AssetPicker } from './asset-picker';
import { uploadAssetAction } from '@/app/(app)/courses/actions';
vi.mock('@/app/(app)/courses/actions', () => ({ uploadAssetAction: vi.fn() }));
it('validates uploads before sending and selects the server asset after completion', async () => {
  const onChange = vi.fn(),
    onUploadStart = vi.fn(),
    onUploadFinish = vi.fn(),
    onAssets = vi.fn(),
    onBusy = vi.fn();
  vi.mocked(uploadAssetAction).mockResolvedValue({
    status: 'ok',
    data: {
      id: 'asset',
      url: 'https://example.test/image.png',
      altText: 'image',
      mimeType: 'image/png',
      createdAt: '',
    },
  });
  render(
    <AssetPicker
      slug="course"
      assets={[]}
      value=""
      onChange={onChange}
      onAssets={onAssets}
      onBusy={onBusy}
      onUploadStart={onUploadStart}
      onUploadFinish={onUploadFinish}
    />,
  );
  fireEvent.change(screen.getByLabelText('上传图片'), {
    target: { files: [new File(['text'], 'test.txt', { type: 'text/plain' })] },
  });
  expect(screen.getByRole('alert')).toHaveTextContent('仅支持');
  expect(uploadAssetAction).not.toHaveBeenCalled();
  const large = new File(['x'], 'large.png', { type: 'image/png' });
  Object.defineProperty(large, 'size', { value: 6 * 1024 * 1024 });
  fireEvent.change(screen.getByLabelText('上传图片'), {
    target: { files: [large] },
  });
  expect(screen.getByRole('alert')).toHaveTextContent('不能超过');
  await act(async () =>
    fireEvent.change(screen.getByLabelText('上传图片'), {
      target: { files: [new File(['x'], 'image.png', { type: 'image/png' })] },
    }),
  );
  expect(onUploadStart).toHaveBeenCalledWith(expect.any(String));
  expect(onUploadFinish).toHaveBeenCalledWith(
    onUploadStart.mock.calls[0][0],
    'asset',
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(onAssets).toHaveBeenCalled();
  expect(onBusy.mock.calls).toEqual([[true], [false]]);
});
it('clears the upload lock and reports an uncertain outcome when transport rejects', async () => {
  const onBusy = vi.fn();
  const onUploadStart = vi.fn();
  const onUploadFinish = vi.fn();
  vi.mocked(uploadAssetAction).mockRejectedValueOnce(
    new Error('lost response'),
  );
  render(
    <AssetPicker
      slug="course"
      assets={[]}
      value=""
      onChange={vi.fn()}
      onAssets={vi.fn()}
      onBusy={onBusy}
      onUploadStart={onUploadStart}
      onUploadFinish={onUploadFinish}
    />,
  );
  await act(async () =>
    fireEvent.change(screen.getByLabelText('上传图片'), {
      target: { files: [new File(['x'], 'image.png', { type: 'image/png' })] },
    }),
  );
  expect(onUploadFinish).toHaveBeenCalledWith(
    onUploadStart.mock.calls[0][0],
    null,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('操作可能已完成');
  expect(screen.getByLabelText('上传图片')).toBeEnabled();
  expect(onBusy.mock.calls).toEqual([[true], [false]]);
});
