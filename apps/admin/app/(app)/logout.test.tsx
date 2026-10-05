import { render, screen } from '@testing-library/react';
import { logoutAction } from './actions';
import AppLayout from './layout';

const session = vi.hoisted(() => ({ clearSession: vi.fn() }));
vi.mock('@/lib/session', () => session);
const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect }));

describe('退出登录', () => {
  it('logoutAction 清 cookie 并回到 /login', async () => {
    await expect(logoutAction()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(session.clearSession).toHaveBeenCalled();
  });

  it('登录后的壳有退出按钮', () => {
    render(<AppLayout>内容</AppLayout>);

    expect(screen.getByRole('button', { name: '退出' })).toBeInTheDocument();
    expect(screen.getByText('内容')).toBeInTheDocument();
  });
});
