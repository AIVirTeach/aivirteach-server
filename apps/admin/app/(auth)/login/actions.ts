'use server';

import { LoginResponseSchema, LoginSchema } from '@aivirteach/admin-contract';
import { redirect } from 'next/navigation';
import { apiBaseUrl } from '@/lib/api-config';
import { setSession } from '@/lib/session';

export type LoginState = { ok: false; message: string } | null;

const UNAVAILABLE = '服务暂时不可用，请稍后重试';

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { ok: false, message: '请输入邮箱和密码' };

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, message: UNAVAILABLE };
  }

  // 一切 4xx 凭证问题统一文案，不区分邮箱不存在/密码错/被锁定/已停用。
  if (response.status === 401) return { ok: false, message: '凭证无效' };
  if (!response.ok) return { ok: false, message: UNAVAILABLE };

  const body = LoginResponseSchema.safeParse(await response.json().catch(() => null));
  if (!body.success) return { ok: false, message: UNAVAILABLE };

  await setSession(body.data.accessToken, body.data.expiresIn);
  redirect('/');
}
