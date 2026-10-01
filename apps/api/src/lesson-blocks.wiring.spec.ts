import { BLOCK_TYPES } from '@aivirteach/lesson-blocks';

describe('lesson-blocks package wiring', () => {
  it('exports all v1 block types', () => {
    expect(BLOCK_TYPES).toHaveLength(13);
  });
});
