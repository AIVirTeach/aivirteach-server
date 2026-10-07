import { SESSION_COOKIE, clearSession, readSessionToken, setSession } from './session';

const store = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: async () => store }));

describe('会话 cookie', () => {
  beforeEach(() => vi.clearAllMocks());

  it('写入 cookie 时 HttpOnly、Secure、SameSite=Strict，maxAge 等于 expiresIn', async () => {
    await setSession('jwt-token', 28800);

    expect(store.set).toHaveBeenCalledWith(SESSION_COOKIE, 'jwt-token', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 28800,
    });
  });

  it('readSessionToken 读回 cookie 的值，没有时返回 undefined', async () => {
    store.get.mockReturnValueOnce({ name: SESSION_COOKIE, value: 'abc' });
    await expect(readSessionToken()).resolves.toBe('abc');

    store.get.mockReturnValueOnce(undefined);
    await expect(readSessionToken()).resolves.toBeUndefined();
    expect(store.get).toHaveBeenCalledWith(SESSION_COOKIE);
  });

  it('clearSession 删除 cookie', async () => {
    await clearSession();

    expect(store.delete).toHaveBeenCalledWith(SESSION_COOKIE);
  });
});
