import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'aivirteach_admin_session';

export async function setSession(accessToken: string, expiresIn: number) {
  (await cookies()).set(SESSION_COOKIE, accessToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: expiresIn,
  });
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function clearSession() {
  (await cookies()).delete(SESSION_COOKIE);
}
