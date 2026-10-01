import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceLessonBody } from './lesson-body';

const SOURCE = readFileSync(
  join(__dirname, '__fixtures__', 'sample-course', 'lesson-source.md'),
  'utf-8',
);

describe('sliceLessonBody', () => {
  it.each([
    ['lesson-1', 3, 4],
    ['lesson-2', 5, 6],
  ])('matches the legacy formula for %s', (_id, startLine, endLine) => {
    const expected = SOURCE.split('\n')
      .slice(startLine - 1, endLine)
      .join('\n');
    expect(sliceLessonBody(SOURCE, { startLine, endLine })).toBe(expected);
  });

  it('matches the legacy formula when endLine is past EOF', () => {
    const range = { startLine: 9, endLine: 100 };
    const expected = SOURCE.split('\n')
      .slice(range.startLine - 1, range.endLine)
      .join('\n');
    expect(sliceLessonBody(SOURCE, range)).toBe(expected);
  });
});
