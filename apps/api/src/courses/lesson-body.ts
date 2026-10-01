export interface LessonSourceRange {
  startLine: number;
  endLine: number;
}

/** Returns the source lines covered by a 1-based, inclusive lesson range. */
export function sliceLessonBody(
  markdown: string,
  range: LessonSourceRange,
): string {
  return markdown
    .split('\n')
    .slice(range.startLine - 1, range.endLine)
    .join('\n');
}
