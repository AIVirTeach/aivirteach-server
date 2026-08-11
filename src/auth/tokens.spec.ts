import {
  InvalidTokenError,
  generateOpaqueToken,
  hashOpaqueToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const claims = { sub: 'user_123', email: 'learner@example.com' };

describe('access token', () => {
  it('签发后能用同一密钥验回原始 claims', async () => {
    const token = await signAccessToken(claims, SECRET, '15m');

    await expect(verifyAccessToken(token, SECRET)).resolves.toEqual(claims);
  });

  it('换一个密钥验签会抛 InvalidTokenError', async () => {
    const token = await signAccessToken(claims, SECRET, '15m');

    await expect(verifyAccessToken(token, OTHER_SECRET)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('已过期的 token 会抛 InvalidTokenError', async () => {
    const token = await signAccessToken(claims, SECRET, '0s');

    await expect(verifyAccessToken(token, SECRET)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('乱码字符串会抛 InvalidTokenError 而不是别的异常', async () => {
    await expect(verifyAccessToken('not.a.jwt', SECRET)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
});

describe('opaque token', () => {
  it('每次生成都不同，且长度足够', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it('哈希是确定的 64 位 hex，且不等于明文', () => {
    const token = generateOpaqueToken();
    const hashed = hashOpaqueToken(token);

    expect(hashed).toBe(hashOpaqueToken(token));
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toBe(token);
  });
});
