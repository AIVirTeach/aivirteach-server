import { BLOCK_TYPES, validateLessonContent } from './index';
import canonical from '../fixtures/canonical-lesson.json';

describe('canonical lesson fixture', () => {
  it('uses fixture version 1', () => {
    expect(canonical.fixtureVersion).toBe(1);
  });

  it('validates the valid lesson without errors or warnings', () => {
    const report = validateLessonContent(canonical.valid, {
      courseAssetIds: new Set(Object.keys(canonical.assets)),
    });

    expect(report).toEqual({ errors: [], warnings: [] });
  });

  it('covers every registered block type', () => {
    const covered = new Set(canonical.valid.blocks.map((block) => block.type));
    expect([...covered].sort()).toEqual([...BLOCK_TYPES].sort());
  });

  it.each(canonical.invalid.map((example) => [example.name, example] as const))(
    'reports expected errors for invalid example: %s',
    (_name, example) => {
      const report = validateLessonContent(example.content, {
        courseAssetIds: new Set(Object.keys(canonical.assets)),
      });
      const actualCodes = new Set(report.errors.map((problem) => problem.code));

      for (const code of example.expectedCodes) {
        expect(actualCodes).toContain(code);
      }
    },
  );
});
