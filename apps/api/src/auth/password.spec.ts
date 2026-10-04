import { hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('哈希结果不等于明文，且用的是 argon2id', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).not.toContain('correct horse');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('同一个密码两次哈希结果不同（加盐）', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);

    expect(a).not.toBe(b);
  });

  it('正确密码验证通过，错误密码不通过', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(
      verifyPassword(hash, 'correct horse battery staple'),
    ).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('哈希串损坏时返回 false 而不是抛错', async () => {
    await expect(verifyPassword('not-a-valid-hash', 'anything')).resolves.toBe(
      false,
    );
  });
});
