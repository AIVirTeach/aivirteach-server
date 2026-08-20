import { z } from 'zod';

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

export const CourseContentSchema = z.object({
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
    encoding: z.string().min(1),
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
