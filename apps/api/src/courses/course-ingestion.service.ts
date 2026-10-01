import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Course, CourseVersion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseAssetStorageService } from './course-asset-storage.service';
import { CourseContentSchema, mapCourseLevel } from './course-content.schemas';
import { sliceLessonBody } from './lesson-body';

export type ConversionIssue = {
  level: 'warning' | 'error';
  code: string;
  message: string;
  line?: number;
};
export type ConversionReport = {
  lessonContentId: string;
  issues: ConversionIssue[];
};
export type IngestedCourse = Course & {
  versions: CourseVersion[];
  conversionReports: ConversionReport[];
};

@Injectable()
export class CourseIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assetStorage: CourseAssetStorageService,
  ) {}

  async ingestFromDirectory(
    contentDir: string,
    imageDigest?: string,
  ): Promise<IngestedCourse> {
    const courseJsonRaw = await readFile(
      resolve(contentDir, 'course.json'),
      'utf-8',
    );
    const content = CourseContentSchema.parse(JSON.parse(courseJsonRaw));

    const sourceMarkdown = await readFile(
      resolve(contentDir, content.source.path),
      content.source.encoding,
    );

    const assets = await Promise.all(
      content.assets.map(async (asset) => ({
        id: asset.id,
        objectKey: await this.assetStorage.upload(
          `courses/${content.slug}/${asset.id}${extname(asset.path)}`,
          resolve(contentDir, asset.path),
        ),
        type: asset.type,
        altText: asset.alt,
      })),
    );

    const { modules, conversionReports } = await this.convertLessons(
      content,
      sourceMarkdown,
      assets,
    );

    try {
      return await this.prisma.course
        .create({
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
              create: assets,
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
                  create: modules,
                },
              },
            },
          },
          include: { versions: true },
        })
        .then((course) => ({ ...course, conversionReports }));
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `课程已存在（slug 或 contentId 冲突）：${content.slug}`,
        );
      }
      throw error;
    }
  }

  async previewConversions(contentDir: string): Promise<ConversionReport[]> {
    const content = CourseContentSchema.parse(
      JSON.parse(await readFile(resolve(contentDir, 'course.json'), 'utf-8')),
    );
    const sourceMarkdown = await readFile(
      resolve(contentDir, content.source.path),
      content.source.encoding,
    );
    const assets = content.assets.map((asset) => ({
      id: asset.id,
      objectKey: asset.path,
      type: asset.type,
      altText: asset.alt,
    }));
    return (await this.convertLessons(content, sourceMarkdown, assets))
      .conversionReports;
  }

  private async convertLessons(
    content: ReturnType<typeof CourseContentSchema.parse>,
    sourceMarkdown: string,
    assets: Array<{
      id: string;
      objectKey: string;
      type: string;
      altText: string;
    }>,
  ) {
    const assetIdsByFilename = new Map(
      assets.map((asset) => [
        asset.objectKey.split(/[\\/]/).filter(Boolean).at(-1)!,
        asset.id,
      ]),
    );
    const conversionReports: ConversionReport[] = [];
    const modules: Prisma.CourseModuleCreateWithoutCourseVersionInput[] = [];
    for (const courseModule of content.modules) {
      const lessons: Prisma.CourseLessonCreateWithoutModuleInput[] = [];
      for (const lesson of courseModule.lessons) {
        const body = sliceLessonBody(sourceMarkdown, lesson.sourceRange);
        const converted = await this.convertMarkdown(body, {
          assetIdsByFilename,
        });
        conversionReports.push({
          lessonContentId: lesson.id,
          issues: converted.report,
        });
        lessons.push({
          contentId: lesson.id,
          position: lesson.position,
          title: lesson.title,
          estimatedMinutes: lesson.estimatedMinutes,
          objectives: lesson.objectives,
          sourceRange: lesson.sourceRange,
          body,
          content: converted.report.some((issue) => issue.level === 'error')
            ? Prisma.DbNull
            : (converted.content as unknown as Prisma.InputJsonValue),
          activityType: lesson.activity.type,
          activityPrompt: lesson.activity.prompt,
          activityCompletionType: lesson.activity.completionType,
          assessmentIds: lesson.assessmentIds,
        });
      }
      modules.push({
        position: courseModule.position,
        title: courseModule.title,
        description: courseModule.description,
        estimatedMinutes: courseModule.estimatedMinutes,
        lessons: { create: lessons },
      });
    }
    return { modules, conversionReports };
  }

  private async convertMarkdown(
    markdown: string,
    context: { assetIdsByFilename: ReadonlyMap<string, string> },
  ) {
    const { convertMarkdownToBlocks } =
      await import('./lesson-conversion/markdown-to-blocks.js');
    return convertMarkdownToBlocks(markdown, context);
  }
}
