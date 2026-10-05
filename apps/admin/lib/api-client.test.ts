import { apiFetch } from './api-client';

const session = vi.hoisted(() => ({
  readSessionToken: vi.fn(),
  clearSession: vi.fn(),
}));
vi.mock('./session', () => session);
const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect }));

describe('apiFetch', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    process.env.API_BASE_URL = 'http://api.test/api/v1';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('带上会话令牌请求 API_BASE_URL + path，并且不缓存', async () => {
    session.readSessionToken.mockResolvedValue('jwt');
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await apiFetch('/admin/token-usage', { method: 'GET' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/admin/token-usage');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer jwt');
    expect(init.cache).toBe('no-store');
  });

  it('没有会话令牌：不发请求，直接去 /login', async () => {
    session.readSessionToken.mockResolvedValue(undefined);

    await expect(apiFetch('/x')).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('API 返回 401：清 cookie 并跳转 /login', async () => {
    session.readSessionToken.mockResolvedValue('jwt');
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }));

    await expect(apiFetch('/x')).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(session.clearSession).toHaveBeenCalled();
  });

  it('在不能写 cookie 的上下文（Server Component）里清 cookie 失败，也照样跳转', async () => {
    session.readSessionToken.mockResolvedValue('jwt');
    session.clearSession.mockRejectedValue(new Error('cookies are read-only'));
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }));

    await expect(apiFetch('/x')).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('其他状态码原样返回，由调用方处理', async () => {
    session.readSessionToken.mockResolvedValue('jwt');
    fetchMock.mockResolvedValue(new Response('{"message":"bad"}', { status: 422 }));

    const response = await apiFetch('/x');

    expect(response.status).toBe(422);
    expect(session.clearSession).not.toHaveBeenCalled();
  });

  it('没配置 API_BASE_URL → 明确报错', async () => {
    delete process.env.API_BASE_URL;
    session.readSessionToken.mockResolvedValue('jwt');

    await expect(apiFetch('/x')).rejects.toThrow('API_BASE_URL');
  });
});
