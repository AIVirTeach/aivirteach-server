import { redirect } from 'next/navigation';
import { apiBaseUrl } from './api-config';
import { clearSession, readSessionToken } from './session';

// 服务端专用：带上会话令牌请求 API；令牌缺失或被 API 拒绝（401）都回到登录页。
export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = apiBaseUrl();
  const token = await readSessionToken();
  if (!token) redirect('/login');

  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });

  if (response.status === 401) {
    // Server Component 里 cookie 只读，清不掉也要跳转；proxy 会在下次导航前再拦一次。
    try {
      await clearSession();
    } catch {
      // 忽略：见上
    }
    redirect('/login');
  }
  return response;
}
