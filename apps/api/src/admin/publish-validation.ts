import { CourseMetaPatchSchema } from './draft/draft.schemas';
import type { DraftVersion } from './draft/draft-version';

export function validateDraftForPublish(input: {
  draft: DraftVersion;
  courseAssetIds: ReadonlySet<string>;
  coverAssetId: string | null;
}): string[] {
  const { draft, courseAssetIds, coverAssetId } = input;
  const problems: string[] = [];
  const modules = [...draft.modules].sort((a, b) => a.position - b.position);
  const lessonIds = new Set<string>();
  let lessonCount = 0;

  if (coverAssetId && !courseAssetIds.has(coverAssetId)) {
    problems.push('封面资源不属于当前课程');
  }
  if (
    draft.welcome?.overviewAssetId &&
    !courseAssetIds.has(draft.welcome.overviewAssetId)
  ) {
    problems.push('欢迎页资源不属于当前课程');
  }

  modules.forEach((module, moduleIndex) => {
    if (module.position !== moduleIndex + 1) {
      problems.push('模块 position 必须连续且从 1 开始');
    }
    const lessons = [...module.lessons].sort((a, b) => a.position - b.position);
    lessons.forEach((lesson, lessonIndex) => {
      lessonCount++;
      if (lesson.position !== lessonIndex + 1) {
        problems.push(
          `模块「${module.title}」的课时 position 必须连续且从 1 开始`,
        );
      }
      if (lessonIds.has(lesson.contentId)) {
        problems.push(`课时 contentId 重复：${lesson.contentId}`);
      }
      lessonIds.add(lesson.contentId);
      if (!lesson.body.trim()) {
        problems.push(
          `模块「${module.title}」/课时「${lesson.title}」：课时内容不能为空`,
        );
      }
    });
  });

  if (lessonCount === 0) problems.push('课程至少需要一个课时');

  if (draft.meta !== null && !isEmptyObject(draft.meta)) {
    const result = CourseMetaPatchSchema.safeParse(draft.meta);
    if (!result.success) problems.push('课程元信息格式无效');
  }

  return problems;
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
