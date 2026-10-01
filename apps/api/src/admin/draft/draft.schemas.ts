import { z } from 'zod';

export const CourseMetaPatchSchema = z
  .object({
    title: z.string().min(1).optional(),
    shortTitle: z.string().min(1).nullable().optional(),
    category: z.string().optional(),
    description: z.string().optional(),
    level: z.enum(['Beginner', 'Intermediate', 'Advanced']).optional(),
    language: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    outcomes: z.array(z.string()).optional(),
    requirements: z.array(z.string()).optional(),
  })
  .strict();

export const WelcomePatchSchema = z
  .object({
    overviewAssetId: z.string().nullable().optional(),
    overviewHeading: z.string().nullable().optional(),
    overviewParagraphs: z.array(z.string()).optional(),
    howItWorksSteps: z.json().nullable().optional(),
    finalOutcome: z.string().nullable().optional(),
  })
  .strict();

export const CreateModuleSchema = z
  .object({
    title: z.string().min(1),
    description: z.string(),
    estimatedMinutes: z.number().int().nonnegative(),
  })
  .strict();

export const UpdateModulePatchSchema = CreateModuleSchema.partial().strict();

const ActivitySchema = z
  .object({
    type: z.string().min(1),
    prompt: z.string(),
    completionType: z.string().min(1),
  })
  .strict();

const LessonFieldsSchema = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    estimatedMinutes: z.number().int().nonnegative().optional(),
    objectives: z.array(z.string()).optional(),
    activity: ActivitySchema.optional(),
  })
  .strict();

export const CreateLessonSchema = z
  .object({
    contentId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().min(1),
    body: z.string().optional(),
    estimatedMinutes: z.number().int().nonnegative(),
    objectives: z.array(z.string()).optional(),
    activity: ActivitySchema,
  })
  .strict();

export const UpdateLessonPatchSchema = LessonFieldsSchema;

export const ReorderSchema = z
  .object({
    modules: z.array(
      z
        .object({ id: z.string().min(1), lessons: z.array(z.string()) })
        .strict(),
    ),
  })
  .strict();

export const UpdateAssessmentPatchSchema = z
  .object({
    type: z.string().min(1).optional(),
    question: z.string().optional(),
    options: z.array(z.string()).optional(),
    clientCriteria: z.array(z.string()).optional(),
    expectedResult: z.string().nullable().optional(),
    successCriteria: z.array(z.string()).optional(),
    commonFailures: z.array(z.string()).optional(),
  })
  .strict();

export type CourseMetaPatch = z.infer<typeof CourseMetaPatchSchema>;
export type WelcomePatch = z.infer<typeof WelcomePatchSchema>;
export type CreateModuleInput = z.infer<typeof CreateModuleSchema>;
export type UpdateModulePatch = z.infer<typeof UpdateModulePatchSchema>;
export type CreateLessonInput = z.infer<typeof CreateLessonSchema>;
export type UpdateLessonPatch = z.infer<typeof UpdateLessonPatchSchema>;
export type ReorderInput = z.infer<typeof ReorderSchema>;
export type UpdateAssessmentPatch = z.infer<typeof UpdateAssessmentPatchSchema>;
