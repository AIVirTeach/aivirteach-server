import { LessonEnvelopeSchema } from './envelope';

describe('LessonEnvelopeSchema', () => {
  const valid = { schemaVersion: 1, blocks: [{ id: 'b-01', type: 'heading', props: { anything: true } }] };

  it('accepts a valid envelope without interpreting props', () => {
    expect(LessonEnvelopeSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts unknown block types', () => {
    expect(LessonEnvelopeSchema.safeParse({ ...valid, blocks: [{ ...valid.blocks[0], type: 'quiz-widget' }] }).success).toBe(true);
  });

  it('rejects an unsupported schema version or non-array blocks', () => {
    expect(LessonEnvelopeSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
    expect(LessonEnvelopeSchema.safeParse({ ...valid, blocks: {} }).success).toBe(false);
  });

  it.each([
    { type: 'heading', props: {} },
    { id: '', type: 'heading', props: {} },
    { id: 'x'.repeat(65), type: 'heading', props: {} },
    { id: 'b-1', type: 'heading', props: null },
  ])('rejects an invalid block shell %#', (block) => {
    expect(LessonEnvelopeSchema.safeParse({ schemaVersion: 1, blocks: [block] }).success).toBe(false);
  });
});
