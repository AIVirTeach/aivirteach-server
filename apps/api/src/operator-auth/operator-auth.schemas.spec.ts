import { EmailSchema, LoginSchema } from './operator-auth.schemas';

describe('运营登录 schema', () => {
  it('邮箱去掉首尾空格并转小写', () => {
    expect(EmailSchema.parse(' Op@X.com ')).toBe('op@x.com');
  });

  it('不是邮箱的字符串被拒绝', () => {
    expect(EmailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('LoginSchema 规范化邮箱并保留密码原样（含首尾空格）', () => {
    expect(
      LoginSchema.parse({ email: ' Op@X.com ', password: ' secret ' }),
    ).toEqual({ email: 'op@x.com', password: ' secret ' });
  });

  it('空密码被拒绝', () => {
    expect(
      LoginSchema.safeParse({ email: 'op@x.com', password: '' }).success,
    ).toBe(false);
  });

  it('128 位密码通过，129 位被拒绝', () => {
    const email = 'op@x.com';
    expect(
      LoginSchema.safeParse({ email, password: 'a'.repeat(128) }).success,
    ).toBe(true);
    expect(
      LoginSchema.safeParse({ email, password: 'a'.repeat(129) }).success,
    ).toBe(false);
  });
});
