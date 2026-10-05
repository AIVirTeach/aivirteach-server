import { NextRequest } from 'next/server';
import { proxy } from './proxy';
import { SESSION_COOKIE } from './lib/session';

const requestFor = (path: string, withSession: boolean) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: withSession ? { cookie: `${SESSION_COOKIE}=jwt` } : {},
  });

describe('proxy', () => {
  it('没有会话访问受保护页面 → 重定向到 /login', () => {
    const response = proxy(requestFor('/courses', false));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('有会话 cookie → 放行', () => {
    const response = proxy(requestFor('/courses', true));

    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('/login 对没有会话的人放行（避免重定向循环）', () => {
    const response = proxy(requestFor('/login', false));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('/login 对带（可能已过期的）会话的人也放行，不会循环', () => {
    const response = proxy(requestFor('/login', true));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
