import { loadEnv } from './env';

const validSource = {
  DATABASE_URL: 'postgresql://u:p@localhost:55432/db',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('填齐必填项时套用默认值', () => {
    expect(loadEnv(validSource)).toEqual({
      DATABASE_URL: 'postgresql://u:p@localhost:55432/db',
      JWT_SECRET: 'x'.repeat(32),
      ACCESS_TOKEN_TTL: '15m',
      REFRESH_TOKEN_TTL_DAYS: 30,
      INVITATION_TTL_DAYS: 7,
      PORT: 4000,
      CORS_ORIGINS: 'tauri://localhost',
    });
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

  it('LABS_CONSOLE_WS_URL 未配置时为 undefined，不影响其余必填校验', () => {
    const env = loadEnv(validSource);
    expect(env.LABS_CONSOLE_WS_URL).toBeUndefined();
  });

  it('LABS_CONSOLE_WS_URL 配置了但不是合法 URL 时抛错', () => {
    expect(() =>
      loadEnv({ ...validSource, LABS_CONSOLE_WS_URL: 'not-a-url' }),
    ).toThrow(/LABS_CONSOLE_WS_URL/);
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
