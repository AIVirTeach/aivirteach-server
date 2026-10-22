import { expect, it, vi } from 'vitest';
import { createPreviewChannel } from './preview-channel';
it('only sends latest content after ready from the exact iframe and origin', () => {
  const target = { postMessage: vi.fn() };
  const channel = createPreviewChannel({
    clientOrigin: 'https://client.test',
    getTarget: () => target as unknown as Window,
  });
  channel.post('old');
  channel.post('latest');
  expect(target.postMessage).not.toHaveBeenCalled();
  expect(
    channel.receive({
      origin: 'https://wrong.test',
      source: target,
      data: { type: 'lesson-preview-ready' },
    } as unknown as MessageEvent),
  ).toBe(false);
  expect(
    channel.receive({
      origin: 'https://client.test',
      source: {},
      data: { type: 'lesson-preview-ready' },
    } as MessageEvent),
  ).toBe(false);
  channel.receive({
    origin: 'https://client.test',
    source: target,
    data: { type: 'lesson-preview-ready' },
  } as unknown as MessageEvent);
  expect(target.postMessage).toHaveBeenCalledWith(
    'latest',
    'https://client.test',
  );
  channel.post('new');
  expect(target.postMessage).toHaveBeenLastCalledWith(
    'new',
    'https://client.test',
  );
});
