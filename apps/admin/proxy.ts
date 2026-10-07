import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/session';

// 只看 cookie 是否存在：真正的校验（过期、停用、改密）由 API 逐次完成。
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === '/login' || request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
