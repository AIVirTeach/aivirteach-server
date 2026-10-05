import { loginAction } from './actions';

const session = vi.hoisted(() => ({ setSession: vi.fn() }));
vi.mock('@/lib/session', () => session);
const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect }));

const form = (email: string, password: string) => {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  return data;
};

describe('loginAction', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    process.env.API_BASE_URL = 'http://api.test/api/v1';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('登录成功：写会话 cookie 并跳转到首页', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ accessToken: 'jwt', expiresIn: 28800 }),
    );

    await expect(loginAction(null, form(' Op@X.com ', 'pw'))).rejects.toThrow(
      'NEXT_REDIRECT:/',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/admin/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'op@x.com',
      password: 'pw',
    });
    expect(session.setSession).toHaveBeenCalledWith('jwt', 28800);
  });

  it('API 返回 401：显示统一文案「凭证无效」，不写 cookie', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(loginAction(null, form('op@x.com', 'bad'))).resolves.toEqual({
      ok: false,
      message: '凭证无效',
    });
    expect(session.setSession).not.toHaveBeenCalled();
  });

  it('邮箱或密码为空时不发请求，提示填写', async () => {
    const result = await loginAction(null, form('', ''));

    expect(result).toEqual({ ok: false, message: '请输入邮箱和密码' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('API 不可用（网络错误或 5xx）：提示稍后重试，不泄露细节', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.1'));
    await expect(loginAction(null, form('op@x.com', 'pw'))).resolves.toEqual({
      ok: false,
      message: '服务暂时不可用，请稍后重试',
    });

    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(loginAction(null, form('op@x.com', 'pw'))).resolves.toEqual({
      ok: false,
      message: '服务暂时不可用，请稍后重试',
    });
  });

  it('API 返回的成功体不符合约定：当作服务不可用', async () => {
    fetchMock.mockResolvedValue(Response.json({ nope: true }));

    await expect(loginAction(null, form('op@x.com', 'pw'))).resolves.toEqual({
      ok: false,
      message: '服务暂时不可用，请稍后重试',
    });
    expect(session.setSession).not.toHaveBeenCalled();
  });
});
