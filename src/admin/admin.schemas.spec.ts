import { OperatorSchema, ReasonSchema } from './admin.schemas';

describe('OperatorSchema', () => {
  it('接受合法邮箱', () => {
    expect(OperatorSchema.parse('ops@example.com')).toBe('ops@example.com');
  });

  it('拒绝非邮箱字符串', () => {
    expect(() => OperatorSchema.parse('not-an-email')).toThrow();
  });
});

describe('ReasonSchema', () => {
  it('接受非空字符串', () => {
    expect(ReasonSchema.parse('封测名单批次 1')).toBe('封测名单批次 1');
  });

  it('拒绝空字符串', () => {
    expect(() => ReasonSchema.parse('')).toThrow();
  });
});
