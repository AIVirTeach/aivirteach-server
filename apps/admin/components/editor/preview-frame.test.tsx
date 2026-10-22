import { act, render, screen } from '@testing-library/react';
import { vi, it, expect, afterEach } from 'vitest';
import { PreviewFrame } from './preview-frame';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it('does not create an iframe without a valid configured origin', () => {
  vi.stubEnv('NEXT_PUBLIC_CLIENT_ORIGIN', '');
  render(<PreviewFrame payload={{}} />);
  expect(screen.getByText('未配置预览地址')).toBeInTheDocument();
  expect(screen.queryByTitle('真实课时预览')).toBeNull();
});
it('times out without ready without preventing editing', async () => {
  vi.useFakeTimers();
  vi.stubEnv('NEXT_PUBLIC_CLIENT_ORIGIN', 'https://client.test');
  render(<PreviewFrame payload={{}} />);
  await act(async () => vi.advanceTimersByTime(5000));
  expect(screen.getByRole('status')).toHaveTextContent('预览不可用');
});
it('sends the latest payload after the actual frame is ready', () => {
  vi.stubEnv('NEXT_PUBLIC_CLIENT_ORIGIN', 'https://client.test');
  const { rerender } = render(<PreviewFrame payload={{ text: 'old' }} />);
  const frame = screen.getByTitle('真实课时预览') as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  rerender(<PreviewFrame payload={{ text: 'latest' }} />);
  act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://client.test',
        source: frame.contentWindow,
        data: { type: 'lesson-preview-ready' },
      }),
    ),
  );
  expect(post).toHaveBeenCalledWith({ text: 'latest' }, 'https://client.test');
  expect(screen.getByRole('status')).toHaveTextContent('已连接真实课时预览');
});
