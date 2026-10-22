import { vi, expect, it } from 'vitest';
import { redirect } from 'next/navigation';
import Home from './page';
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
it('opens the course studio after login', () => {
  Home();
  expect(redirect).toHaveBeenCalledWith('/courses');
});
