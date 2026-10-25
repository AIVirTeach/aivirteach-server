import { z } from 'zod';

export const CourseListItemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  published: z.boolean(),
  latestPublishedVersion: z.number().int().nullable(),
  hasDraft: z.boolean(),
  lessonCount: z.number().int().nonnegative(),
  activeEnrollments: z.number().int().nonnegative(),
});
export type CourseListItem = z.infer<typeof CourseListItemSchema>;
export const CourseAssetSchema = z.object({
  id: z.string(),
  url: z.string(),
  altText: z.string().nullable(),
  mimeType: z.string().nullable(),
  createdAt: z.string(),
});
export type CourseAsset = z.infer<typeof CourseAssetSchema>;
export const CreateAssessmentSchema = z
  .object({
    type: z.string().min(1),
    question: z.string().min(1),
    options: z.array(z.string()).default([]),
    clientCriteria: z.array(z.string()).default([]),
    expectedResult: z.string().nullable().default(null),
    successCriteria: z.array(z.string()).default([]),
    commonFailures: z.array(z.string()).default([]),
  })
  .strict();
export type CreateAssessmentInput = z.input<typeof CreateAssessmentSchema>;
export const DraftAssessmentSchema = CreateAssessmentSchema.extend({
  question: z.string(),
  id: z.string(),
  lessonId: z.string(),
});
export type DraftAssessment = z.infer<typeof DraftAssessmentSchema>;
const LessonSummarySchema = z.object({
  id: z.string(),
  contentId: z.string(),
  moduleId: z.string(),
  position: z.number().int(),
  title: z.string(),
  estimatedMinutes: z.number(),
  objectives: z.array(z.string()),
  activityType: z.string(),
  activityPrompt: z.string(),
  activityCompletionType: z.string(),
  assessmentIds: z.array(z.string()),
  assessments: z.array(DraftAssessmentSchema),
});
export const DraftLessonSchema = LessonSummarySchema.extend({
  content: z.json().nullable(),
});
export type DraftLesson = z.infer<typeof DraftLessonSchema>;
const ModuleSummarySchema = z.object({
  id: z.string(),
  courseVersionId: z.string(),
  position: z.number().int(),
  title: z.string(),
  description: z.string(),
  estimatedMinutes: z.number(),
  lessons: z.array(LessonSummarySchema),
});
export const DraftModuleSchema = ModuleSummarySchema.extend({
  lessons: z.array(DraftLessonSchema),
});
export type DraftModule = z.infer<typeof DraftModuleSchema>;
export const DraftSummarySchema = z.object({
  id: z.string(),
  courseId: z.string(),
  version: z.number().int(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  meta: z.json().nullable(),
  modules: z.array(ModuleSummarySchema),
  welcome: z
    .object({
      id: z.string(),
      courseVersionId: z.string(),
      overviewAssetId: z.string().nullable(),
      overviewHeading: z.string().nullable(),
      overviewParagraphs: z.array(z.string()),
      howItWorksSteps: z.json().nullable(),
      finalOutcome: z.string().nullable(),
    })
    .nullable(),
});
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
export const DraftVersionSchema = DraftSummarySchema.extend({
  modules: z.array(DraftModuleSchema),
});
export type DraftVersion = z.infer<typeof DraftVersionSchema>;
export const CourseMetaSchema = z.object({
  title: z.string(),
  shortTitle: z.string().nullable(),
  category: z.string(),
  description: z.string(),
  level: z.enum(['Beginner', 'Intermediate', 'Advanced']),
  language: z.string(),
  tags: z.array(z.string()),
  outcomes: z.array(z.string()),
  requirements: z.array(z.string()),
});
export type CourseMeta = z.infer<typeof CourseMetaSchema>;
export const CourseDraftReadSchema = DraftVersionSchema.extend({
  effectiveMeta: CourseMetaSchema,
});
export type CourseDraftRead = z.infer<typeof CourseDraftReadSchema>;

export const PublishIssueSchema = z.object({
  message: z.string(),
  moduleId: z.string().optional(),
  contentId: z.string().optional(),
  blockId: z.string().optional(),
});
export type PublishIssue = z.infer<typeof PublishIssueSchema>;
export const PublishErrorSchema = z.object({
  message: z.string(),
  problems: z.array(z.string()),
  issues: z.array(PublishIssueSchema),
});
export type PublishError = z.infer<typeof PublishErrorSchema>;
export const ContentProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  blockId: z.string().optional(),
  level: z.enum(['error', 'warning']),
  blockIndex: z.number().int().optional(),
  fieldPath: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
});
export const ValidationReportSchema = z.object({
  errors: z.array(ContentProblemSchema),
  warnings: z.array(ContentProblemSchema),
});
export const ContentValidationErrorSchema = z.object({
  message: z.string(),
  problems: z.array(z.string()),
  validation: ValidationReportSchema,
});
export type ContentValidationError = z.infer<typeof ContentValidationErrorSchema>;
export const LessonSaveResultSchema = z.object({
  draft: DraftSummarySchema,
  problems: ValidationReportSchema,
});
export type LessonSaveResult = z.infer<typeof LessonSaveResultSchema>;
