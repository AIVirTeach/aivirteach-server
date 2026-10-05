import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from './login-form';

const loginAction = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ loginAction }));

describe('LoginForm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('渲染邮箱、密码输入框和登录按钮', () => {
    render(<LoginForm />);

    expect(screen.getByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
  });

  it('登录失败时显示 action 返回的文案', async () => {
    loginAction.mockResolvedValue({ ok: false, message: '凭证无效' });
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText('邮箱'), 'op@x.com');
    await userEvent.type(screen.getByLabelText('密码'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('凭证无效');
  });
});
