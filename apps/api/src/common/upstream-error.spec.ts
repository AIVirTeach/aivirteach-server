import { classifyUpstreamStatus } from './upstream-error';

describe('classifyUpstreamStatus', () => {
  it.each([408, 429, 500, 502, 503, 504])('%i 归类为 retryable（瞬时性问题，重试有意义）', (status) => {
    expect(classifyUpstreamStatus(status)).toBe('retryable');
  });

  it.each([400, 401, 403, 404, 422])('%i 归类为 unavailable（重试大概率没用，应提示联系客服）', (status) => {
    expect(classifyUpstreamStatus(status)).toBe('unavailable');
  });
});
