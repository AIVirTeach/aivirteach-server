import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { Course, CourseVersion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseContentSchema, mapCourseLevel } from './course-content.schemas';

@Injectable()
export class CourseIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  async ingestFromDirectory(
    contentDir: string,
    imageDigest?: string,
  ): Promise<Course & { versions: CourseVersion[] }> {
    const courseJsonRaw = await readFile(resolve(contentDir, 'course.json'), 'utf-8');
    const content = CourseContentSchema.parse(JSON.parse(courseJsonRaw));

    const sourceMarkdown = await readFile(
      resolve(contentDir, content.source.path),
      content.source.encoding as BufferEncoding,
    );

    return this.prisma.course.create({
      data: {
        slug: content.slug,
        contentId: content.id,
        title: content.metadata.title,
        shortTitle: content.metadata.shortTitle ?? null,
        category: content.metadata.category,
        description: content.metadata.description,
        level: mapCourseLevel(content.metadata.level),
        language: content.metadata.language,
        durationMinutes: content.metadata.durationMinutes,
        lessonCount: content.metadata.lessonCount,
        tags: content.metadata.tags,
        outcomes: content.outcomes,
        requirements: content.requirements,
        assets: {
          create: content.assets.map((asset) => ({
            objectKey: asset.path,
            type: asset.type,
            altText: asset.alt,
          })),
        },
        versions: {
          create: {
            version: content.version,
            imageDigest: imageDigest ?? null,
            sourceFormat: content.source.format,
            sourcePath: content.source.path,
            sourceEncoding: content.source.encoding,
            sourceMarkdown,
            introSourceRange: content.introduction.sourceRange,
            introFeaturedAssetIds: content.introduction.featuredAssetIds,
            modules: {
              create: content.modules.map((courseModule) => ({
                position: courseModule.position,
                title: courseModule.title,
                description: courseModule.description,
                estimatedMinutes: courseModule.estimatedMinutes,
                lessons: {
                  create: courseModule.lessons.map((lesson) => ({
                    position: lesson.position,
                    title: lesson.title,
                    estimatedMinutes: lesson.estimatedMinutes,
                    objectives: lesson.objectives,
                    sourceRange: lesson.sourceRange,
                    activityType: lesson.activity.type,
                    activityPrompt: lesson.activity.prompt,
                    activityCompletionType: lesson.activity.completionType,
                    assessmentIds: lesson.assessmentIds,
                  })),
                },
              })),
            },
          },
        },
      },
      include: { versions: true },
    });
  }
}
