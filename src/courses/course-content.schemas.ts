import { z } from 'zod';

// Node readFile 支持的 BufferEncoding 取值；course.json 里写错（如 "uft-8"）要在 Zod 这层拒绝，
// 不能等到 readFile 内部抛一个含糊的低级错误。
const SOURCE_ENCODINGS = [
  'ascii',
  'utf8',
  'utf-8',
  'utf16le',
  'utf-16le',
  'ucs2',
  'ucs-2',
  'base64',
  'base64url',
  'latin1',
  'binary',
  'hex',
] as const;

const SourceRangeSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

const AssetSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  path: z.string().min(1),
  alt: z.string().min(1),
});

const ActivitySchema = z.object({
  type: z.string().min(1),
  prompt: z.string().min(1),
  completionType: z.string().min(1),
});

const LessonSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().positive(),
  title: z.string().min(1),
  estimatedMinutes: z.number().int().nonnegative(),
  sourceRange: SourceRangeSchema,
  objectives: z.array(z.string().min(1)),
  activity: ActivitySchema,
  assessmentIds: z.array(z.string().min(1)),
});

const ModuleSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  estimatedMinutes: z.number().int().nonnegative(),
  lessons: z.array(LessonSchema).min(1),
});

export const CourseContentSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    id: z.string().min(1),
    slug: z.string().min(1),
    version: z.number().int().positive(),
    status: z.string().min(1),
    metadata: z.object({
      title: z.string().min(1),
      shortTitle: z.string().min(1).optional(),
      category: z.string().min(1),
      description: z.string().min(1),
      level: z.string().min(1),
      durationMinutes: z.number().int().nonnegative(),
      lessonCount: z.number().int().nonnegative(),
      language: z.string().min(1),
      tags: z.array(z.string().min(1)),
    }),
    outcomes: z.array(z.string().min(1)),
    requirements: z.array(z.string().min(1)),
    source: z.object({
      format: z.string().min(1),
      path: z.string().min(1),
      encoding: z.enum(SOURCE_ENCODINGS),
    }),
    assets: z.array(AssetSchema),
    introduction: z.object({
      sourceRange: SourceRangeSchema,
      featuredAssetIds: z.array(z.string().min(1)),
    }),
    welcome: z.object({ path: z.string().min(1) }),
    modules: z.array(ModuleSchema).min(1),
    assessments: z.object({
      path: z.string().min(1),
      delivery: z.string().min(1),
    }),
  })
  .superRefine((content, ctx) => {
    // CourseLesson.contentId 只在数据库里按模块（moduleId + contentId）唯一约束，
    // 同一课程内跨模块复用课时 id 不会被 DB 拦住，会导致 getLesson/completeLesson 的
    // flatMap+findIndex 定位到错误的、靠前的那一课，后面那课永久不可达。
    // 这里在 ingestion 入口（写库之前）就拒绝，把错误挡在内容作者这一层。
    const firstSeenInModule = new Map<string, number>();
    content.modules.forEach((courseModule, moduleIndex) => {
      courseModule.lessons.forEach((lesson) => {
        const firstModuleIndex = firstSeenInModule.get(lesson.id);
        if (firstModuleIndex !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `课时 id 在同一课程内重复："${lesson.id}"（模块 ${firstModuleIndex + 1} 和模块 ${moduleIndex + 1} 都用了它，课时 id 必须在整个课程内唯一）`,
            path: ['modules', moduleIndex, 'lessons'],
          });
        } else {
          firstSeenInModule.set(lesson.id, moduleIndex);
        }
      });
    });
  });

export type CourseContent = z.infer<typeof CourseContentSchema>;

type CourseLevelEnum = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

const LEVEL_MAP: Record<string, CourseLevelEnum> = {
  beginner: 'BEGINNER',
  intermediate: 'INTERMEDIATE',
  advanced: 'ADVANCED',
};

export function mapCourseLevel(level: string): CourseLevelEnum {
  const mapped = LEVEL_MAP[level.trim().toLowerCase()];
  if (!mapped) {
    throw new Error(
      `未知的课程难度："${level}"，course.json 的 metadata.level 只能是 Beginner/Intermediate/Advanced`,
    );
  }
  return mapped;
}
