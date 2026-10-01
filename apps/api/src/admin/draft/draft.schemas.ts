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

export type CourseMetaPatch = z.infer<typeof CourseMetaPatchSchema>;
export type WelcomePatch = z.infer<typeof WelcomePatchSchema>;
