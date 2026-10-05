import { loadEnv } from './env';

const validSource = {
  DATABASE_URL: 'postgresql://u:p@localhost:55432/db',
  JWT_SECRET: 'x'.repeat(32),
  ADMIN_API_TOKEN: 'a'.repeat(32),
};

describe('loadEnv', () => {
  it('填齐必填项时套用默认值', () => {
    expect(loadEnv(validSource)).toEqual({
      DATABASE_URL: 'postgresql://u:p@localhost:55432/db',
      JWT_SECRET: 'x'.repeat(32),
      ADMIN_API_TOKEN: 'a'.repeat(32),
      ACCESS_TOKEN_TTL: '15m',
      REFRESH_TOKEN_TTL_DAYS: 30,
      INVITATION_TTL_DAYS: 7,
      PORT: 4000,
      CORS_ORIGINS: 'tauri://localhost',
      WORKSPACE_IDLE_TIMEOUT_MINUTES: 15,
      TOKEN_QUOTA_ENFORCED: false,
      TOKEN_WEIGHT_CACHE_HIT: 0.02,
      TOKEN_WEIGHT_INPUT_MISS: 1,
      TOKEN_WEIGHT_OUTPUT: 4,
    });
  });

  it('TOKEN_QUOTA_ENFORCED 只认 true/false 字符串，"false" 不能被当成真值', () => {
    expect(
      loadEnv({ ...validSource, TOKEN_QUOTA_ENFORCED: 'true' })
        .TOKEN_QUOTA_ENFORCED,
    ).toBe(true);
    expect(
      loadEnv({ ...validSource, TOKEN_QUOTA_ENFORCED: 'false' })
        .TOKEN_QUOTA_ENFORCED,
    ).toBe(false);
    expect(() =>
      loadEnv({ ...validSource, TOKEN_QUOTA_ENFORCED: 'yes' }),
    ).toThrow(/TOKEN_QUOTA_ENFORCED/);
  });

  it('token 权重从字符串转成数字，不接受负数', () => {
    const env = loadEnv({
      ...validSource,
      TOKEN_WEIGHT_CACHE_HIT: '0.1',
      TOKEN_WEIGHT_INPUT_MISS: '2',
      TOKEN_WEIGHT_OUTPUT: '8',
    });
    expect([
      env.TOKEN_WEIGHT_CACHE_HIT,
      env.TOKEN_WEIGHT_INPUT_MISS,
      env.TOKEN_WEIGHT_OUTPUT,
    ]).toEqual([0.1, 2, 8]);
    expect(() =>
      loadEnv({ ...validSource, TOKEN_WEIGHT_OUTPUT: '-1' }),
    ).toThrow(/TOKEN_WEIGHT_OUTPUT/);
  });

  it('token 权重留空（如 TOKEN_WEIGHT_OUTPUT=）按未设置处理，不会变成 0', () => {
    const env = loadEnv({
      ...validSource,
      TOKEN_WEIGHT_CACHE_HIT: '',
      TOKEN_WEIGHT_INPUT_MISS: '',
      TOKEN_WEIGHT_OUTPUT: '',
    });
    expect([
      env.TOKEN_WEIGHT_CACHE_HIT,
      env.TOKEN_WEIGHT_INPUT_MISS,
      env.TOKEN_WEIGHT_OUTPUT,
    ]).toEqual([0.02, 1, 4]);
  });

  it('把数字型变量从字符串强制转换', () => {
    const env = loadEnv({
      ...validSource,
      PORT: '4100',
      REFRESH_TOKEN_TTL_DAYS: '7',
    });

    expect(env.PORT).toBe(4100);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(7);
  });

  it('缺少 ADMIN_API_TOKEN 时抛错并指名字段', () => {
    const { ADMIN_API_TOKEN: _token, ...source } = validSource;
    void _token;
    expect(() => loadEnv(source)).toThrow(/ADMIN_API_TOKEN/);
  });

  it('ADMIN_API_TOKEN 太短时抛错并指名字段', () => {
    expect(() => loadEnv({ ...validSource, ADMIN_API_TOKEN: 'short' })).toThrow(
      /ADMIN_API_TOKEN/,
    );
  });

  it('JWT_SECRET 太短时抛错并指名字段', () => {
    expect(() => loadEnv({ ...validSource, JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('缺少 DATABASE_URL 时抛错并指名字段', () => {
    expect(() => loadEnv({ JWT_SECRET: 'x'.repeat(32) })).toThrow(
      /DATABASE_URL/,
    );
  });
});
