import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Course, CourseVersion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseAssetStorageService } from './course-asset-storage.service';
import { CourseContentSchema, mapCourseLevel } from './course-content.schemas';

@Injectable()
export class CourseIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assetStorage: CourseAssetStorageService,
  ) {}

  async ingestFromDirectory(
    contentDir: string,
    imageDigest?: string,
  ): Promise<Course & { versions: CourseVersion[] }> {
    const courseJsonRaw = await readFile(resolve(contentDir, 'course.json'), 'utf-8');
    const content = CourseContentSchema.parse(JSON.parse(courseJsonRaw));

    const sourceMarkdown = await readFile(resolve(contentDir, content.source.path), content.source.encoding);

    const assets = await Promise.all(
      content.assets.map(async (asset) => ({
        objectKey: await this.assetStorage.upload(
          `courses/${content.slug}/${asset.id}${extname(asset.path)}`,
          resolve(contentDir, asset.path),
        ),
        type: asset.type,
        altText: asset.alt,
      })),
    );

    try {
      return await this.prisma.course.create({
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
                create: content.modules.map((courseModule) => ({
                  position: courseModule.position,
                  title: courseModule.title,
                  description: courseModule.description,
                  estimatedMinutes: courseModule.estimatedMinutes,
                  lessons: {
                    create: courseModule.lessons.map((lesson) => ({
                      contentId: lesson.id,
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
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`课程已存在（slug 或 contentId 冲突）：${content.slug}`);
      }
      throw error;
    }
  }
}
