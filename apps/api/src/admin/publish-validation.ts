import type { PublishIssue } from '@aivirteach/admin-contract';
import { CourseMetaPatchSchema } from './draft/draft.schemas';
import type { DraftVersion } from './draft/draft-version';
import {
  countRenderableBlocks,
  validateLessonContent,
} from '@aivirteach/lesson-blocks';

export function collectDraftPublishIssues(input: {
  draft: DraftVersion;
  courseAssetIds: ReadonlySet<string>;
  coverAssetId: string | null;
  isFirstPublish: boolean;
}): PublishIssue[] {
  const { draft, courseAssetIds, coverAssetId, isFirstPublish } = input;
  const issues: PublishIssue[] = [];
  const add = (message: string, location: Omit<PublishIssue, 'message'> = {}) =>
    issues.push({ message, ...location });
  const modules = [...draft.modules].sort((a, b) => a.position - b.position);
  const lessonIds = new Set<string>();

  if (isFirstPublish && modules.length === 0) {
    add('首次发布的课程至少需要一个模块');
  }

  if (coverAssetId && !courseAssetIds.has(coverAssetId)) {
    add('封面资源不属于当前课程');
  }
  if (
    draft.welcome?.overviewAssetId &&
    !courseAssetIds.has(draft.welcome.overviewAssetId)
  ) {
    add('欢迎页资源不属于当前课程');
  }

  if (modules.every((module) => module.lessons.length === 0)) {
    // 首次发布已有更具体的“至少一个模块/课时”提示，不重复报。
    if (!isFirstPublish) add('课程至少需要一个课时');
  }

  modules.forEach((module, moduleIndex) => {
    if (module.position !== moduleIndex + 1) {
      add('模块 position 必须连续且从 1 开始', { moduleId: module.id });
    }
    const lessons = [...module.lessons].sort((a, b) => a.position - b.position);
    if (isFirstPublish && lessons.length === 0) {
      add(`模块「${module.title}」至少需要一个课时`, { moduleId: module.id });
    }
    lessons.forEach((lesson, lessonIndex) => {
      const location = { moduleId: module.id, contentId: lesson.contentId };
      if (lesson.position !== lessonIndex + 1) {
        add(
          `模块「${module.title}」的课时 position 必须连续且从 1 开始`,
          location,
        );
      }
      if (lessonIds.has(lesson.contentId)) {
        add(`课时 contentId 重复：${lesson.contentId}`, location);
      }
      lessonIds.add(lesson.contentId);
      const prefix = `模块「${module.title}」/课时「${lesson.title}」：`;
      const report = validateLessonContent(lesson.content, { courseAssetIds });
      for (const error of report.errors) {
        add(`${prefix}${error.message}`, {
          ...location,
          ...(error.blockId ? { blockId: error.blockId } : {}),
        });
      }
      if (countRenderableBlocks(lesson.content) < 1) {
        add(`${prefix}没有可渲染内容块`, location);
      }
    });
  });

  if (draft.meta !== null && !isEmptyObject(draft.meta)) {
    const result = CourseMetaPatchSchema.safeParse(draft.meta);
    if (!result.success) add('课程元信息格式无效');
  }

  return issues;
}

export function validateDraftForPublish(
  input: Parameters<typeof collectDraftPublishIssues>[0],
): string[] {
  return collectDraftPublishIssues(input).map((issue) => issue.message);
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
