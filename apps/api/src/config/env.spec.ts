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

  it('缺少 ADMIN_API_TOKEN 时抛错并指名字段', () => {
    const { ADMIN_API_TOKEN: _token, ...source } = validSource;
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
