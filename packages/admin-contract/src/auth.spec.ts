import {
  EmailSchema,
  LoginResponseSchema,
  LoginSchema,
  MAX_PASSWORD_LENGTH,
} from './auth';

describe('admin auth contract', () => {
  it('邮箱去掉首尾空格并转小写', () => {
    expect(EmailSchema.parse(' Op@X.com ')).toBe('op@x.com');
  });

  it('超过 254 字符的邮箱被拒绝，不让匿名请求把超长字符串写进审计', () => {
    const long = `${'a'.repeat(900 * 1024)}@x.com`;
    expect(EmailSchema.safeParse(long).success).toBe(false);
    expect(LoginSchema.safeParse({ email: long, password: 'p' }).success).toBe(
      false,
    );
  });

  it('不是邮箱的字符串被拒绝', () => {
    expect(EmailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('LoginSchema 规范化邮箱并保留密码原样（含首尾空格）', () => {
    expect(
      LoginSchema.parse({ email: ' Op@X.com ', password: ' secret ' }),
    ).toEqual({ email: 'op@x.com', password: ' secret ' });
  });

  it('空密码被拒绝，128 位通过，129 位被拒绝', () => {
    const email = 'op@x.com';
    expect(LoginSchema.safeParse({ email, password: '' }).success).toBe(false);
    expect(MAX_PASSWORD_LENGTH).toBe(128);
    expect(
      LoginSchema.safeParse({ email, password: 'a'.repeat(128) }).success,
    ).toBe(true);
    expect(
      LoginSchema.safeParse({ email, password: 'a'.repeat(129) }).success,
    ).toBe(false);
  });

  it('LoginResponseSchema 只接受 accessToken 与正整数 expiresIn', () => {
    expect(
      LoginResponseSchema.parse({ accessToken: 'jwt', expiresIn: 28800 }),
    ).toEqual({ accessToken: 'jwt', expiresIn: 28800 });
    expect(
      LoginResponseSchema.safeParse({ accessToken: '', expiresIn: 1 }).success,
    ).toBe(false);
    expect(
      LoginResponseSchema.safeParse({ accessToken: 'jwt', expiresIn: 0 })
        .success,
    ).toBe(false);
  });
});
