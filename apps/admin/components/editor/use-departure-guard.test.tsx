import { renderHook, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useDepartureGuard } from './use-departure-guard';
it('guards links, logout, reload and browser Back until all dirty guards clear', () => {
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const forward = vi
    .spyOn(window.history, 'forward')
    .mockImplementation(() => {});
  const { rerender, unmount } = renderHook(
    ({ dirty }) => useDepartureGuard(dirty),
    { initialProps: { dirty: true } },
  );
  const link = document.createElement('a');
  link.href = '/courses';
  document.body.append(link);
  expect(fireEvent.click(link)).toBe(false);
  const login = document.createElement('a');
  login.href = '/login';
  login.target = '_blank';
  document.body.append(login);
  expect(fireEvent.click(login)).toBe(true);
  const form = document.createElement('form');
  form.dataset.logout = 'true';
  document.body.append(form);
  expect(fireEvent.submit(form)).toBe(false);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  expect(forward).toHaveBeenCalledTimes(1);
  window.dispatchEvent(
    new PopStateEvent('popstate', {
      state: { courseEditorGuard: window.location.href },
    }),
  );
  expect(forward).toHaveBeenCalledTimes(1);
  rerender({ dirty: false });
  const clean = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  expect(forward).toHaveBeenCalledTimes(1);
  unmount();
  link.remove();
  login.remove();
  form.remove();
  alert.mockRestore();
  forward.mockRestore();
});

it('rearms history protection after a clean Back consumed the sentinel', () => {
  const push = vi.spyOn(window.history, 'pushState');
  const { rerender, unmount } = renderHook(
    ({ dirty }) => useDepartureGuard(dirty),
    { initialProps: { dirty: true } },
  );
  rerender({ dirty: false });
  window.history.replaceState({ restored: true }, '', window.location.href);
  const calls = push.mock.calls.length;
  rerender({ dirty: true });
  expect(push).toHaveBeenCalledTimes(calls + 1);
  expect(window.history.state.courseEditorGuard).toBe(window.location.href);
  unmount();
  push.mockRestore();
});
