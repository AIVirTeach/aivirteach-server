import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditActorType, Prisma, type CourseVersion } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { mapCourseLevel } from '../courses/course-content.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { CourseDraftService } from './draft/course-draft.service';
import { CourseMetaPatchSchema } from './draft/draft.schemas';
import { DRAFT_INCLUDE } from './draft/draft-version';
import { validateDraftForPublish } from './publish-validation';
import { remapRemovedLessons } from './progress-remap';

@Injectable()
export class CoursePublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: CourseDraftService,
    private readonly audit: AuditService,
  ) {}

  async publish(
    slug: string,
    operator: string,
    reason: string,
  ): Promise<CourseVersion> {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course) throw new NotFoundException(`找不到课程：${slug}`);

    const latest = await this.prisma.courseVersion.findFirst({
      where: { courseId: course.id },
      orderBy: { version: 'desc' },
    });
    if (!latest) throw new NotFoundException(`课程 ${slug} 还没有任何版本`);

    // The highest published version with no newer draft is already the active version.
    if (latest.publishedAt) return latest;

    const draft = await this.drafts.requireDraft(slug);
    const assets = await this.prisma.courseAsset.findMany({
      where: { courseId: course.id },
      select: { id: true },
    });
    const problems = validateDraftForPublish({
      draft,
      courseAssetIds: new Set(assets.map((asset) => asset.id)),
      coverAssetId: course.coverAssetId,
    });
    if (problems.length) {
      throw new UnprocessableEntityException({
        message: '草稿校验未通过',
        problems,
      });
    }

    const oldOrder = await this.latestPublishedLessonOrder(course.id);
    const newOrder = draft.modules
      .slice()
      .sort((a, b) => a.position - b.position)
      .flatMap((module) =>
        module.lessons
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((lesson) => lesson.contentId),
      );
    const remap = remapRemovedLessons(oldOrder, newOrder);
    const allLessons = draft.modules.flatMap((module) => module.lessons);
    const meta =
      draft.meta && isJsonObject(draft.meta)
        ? CourseMetaPatchSchema.parse(draft.meta)
        : {};

    const published = await this.prisma.$transaction(async (tx) => {
      const publishResult = await tx.courseVersion.updateMany({
        where: { id: draft.id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      if (publishResult.count !== 1) {
        const winner = await tx.courseVersion.findUnique({
          where: { id: draft.id },
        });
        if (winner?.publishedAt) return winner;
        throw new Error(`课程草稿 ${slug} 已发生并发变化`);
      }

      await tx.course.update({
        where: { id: course.id },
        data: {
          published: true,
          lessonCount: allLessons.length,
          durationMinutes: allLessons.reduce(
            (sum, lesson) => sum + lesson.estimatedMinutes,
            0,
          ),
          ...(meta.title !== undefined ? { title: meta.title } : {}),
          ...(meta.shortTitle !== undefined
            ? { shortTitle: meta.shortTitle }
            : {}),
          ...(meta.category !== undefined ? { category: meta.category } : {}),
          ...(meta.description !== undefined
            ? { description: meta.description }
            : {}),
          ...(meta.level !== undefined
            ? { level: mapCourseLevel(meta.level) }
            : {}),
          ...(meta.language !== undefined ? { language: meta.language } : {}),
          ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
          ...(meta.outcomes !== undefined ? { outcomes: meta.outcomes } : {}),
          ...(meta.requirements !== undefined
            ? { requirements: meta.requirements }
            : {}),
        },
      });

      for (const [removedId, nextId] of remap) {
        await tx.progress.updateMany({
          where: {
            currentLessonContentId: removedId,
            enrollment: { is: { courseId: course.id } },
          },
          data: { currentLessonContentId: nextId },
        });
      }

      const version = await tx.courseVersion.findUnique({
        where: { id: draft.id },
        include: DRAFT_INCLUDE,
      });
      if (!version) throw new NotFoundException(`课程草稿 ${slug} 不存在`);
      return version;
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.publishCourse',
      success: true,
      targetType: 'CourseVersion',
      targetId: published.id,
      reason,
      metadata: { slug, version: published.version },
    });

    return published;
  }

  private async latestPublishedLessonOrder(
    courseId: string,
  ): Promise<string[]> {
    const published = await this.prisma.courseVersion.findFirst({
      where: { courseId, publishedAt: { not: null } },
      orderBy: { version: 'desc' },
      include: {
        modules: {
          orderBy: { position: 'asc' },
          include: { lessons: { orderBy: { position: 'asc' } } },
        },
      },
    });
    return (
      published?.modules.flatMap((module) =>
        module.lessons.map((lesson) => lesson.contentId),
      ) ?? []
    );
  }
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
