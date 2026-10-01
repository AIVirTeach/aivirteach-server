import {
  InvalidTokenError,
  generateOpaqueToken,
  hashOpaqueToken,
  signAccessToken,
  ttlToSeconds,
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

describe('ttlToSeconds', () => {
  it.each([
    ['15m', 15 * 60],
    ['1h', 60 * 60],
    ['7d', 7 * 24 * 60 * 60],
    ['30s', 30],
  ])('把 %s 换算成 %i 秒', (ttl, seconds) => {
    expect(ttlToSeconds(ttl)).toBe(seconds);
  });

  it('格式不对就抛错，而不是静默返回错误的秒数', () => {
    expect(() => ttlToSeconds('15 minutes')).toThrow();
  });
});
