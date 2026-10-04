import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CourseMetaPatchSchema,
  type CourseMetaPatch,
  WelcomePatchSchema,
  type WelcomePatch,
} from './draft.schemas';
import {
  DRAFT_INCLUDE,
  requireUnpublishedVersion,
  type DraftVersion,
} from './draft-version';

@Injectable()
export class CourseDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createDraft(
    slug: string,
    operator: string,
  ): Promise<{ draft: DraftVersion; created: boolean }> {
    const course = await this.prisma.course.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!course) throw new NotFoundException(`课程 ${slug} 不存在`);

    const existing = await this.findDraft(course.id);
    if (existing) return { draft: existing, created: false };

    const source = await this.prisma.courseVersion.findFirst({
      where: { courseId: course.id, publishedAt: { not: null } },
      orderBy: { version: 'desc' },
      include: DRAFT_INCLUDE,
    });
    if (!source) {
      throw new NotFoundException(`课程 ${slug} 没有已发布版本可供复制`);
    }

    try {
      const draft = await this.prisma.$transaction(async (tx) => {
        const created = await tx.courseVersion.create({
          data: {
            courseId: course.id,
            version: source.version + 1,
            imageDigest: source.imageDigest,
            sourceFormat: source.sourceFormat,
            sourcePath: source.sourcePath,
            sourceEncoding: source.sourceEncoding,
            introSourceRange: source.introSourceRange ?? undefined,
            introFeaturedAssetIds: source.introFeaturedAssetIds,
            modules: {
              create: source.modules.map((module) => ({
                position: module.position,
                title: module.title,
                description: module.description,
                estimatedMinutes: module.estimatedMinutes,
                lessons: {
                  create: module.lessons.map((lesson) => ({
                    contentId: lesson.contentId,
                    position: lesson.position,
                    title: lesson.title,
                    estimatedMinutes: lesson.estimatedMinutes,
                    objectives: lesson.objectives,
                    sourceRange: lesson.sourceRange ?? undefined,
                    body: lesson.body,
                    content:
                      lesson.content === null ? Prisma.DbNull : lesson.content,
                    activityType: lesson.activityType,
                    activityPrompt: lesson.activityPrompt,
                    activityCompletionType: lesson.activityCompletionType,
                    assessmentIds: lesson.assessmentIds,
                    assessments: {
                      create: lesson.assessments.map((assessment) => ({
                        type: assessment.type,
                        question: assessment.question,
                        options: assessment.options,
                        clientCriteria: assessment.clientCriteria,
                        expectedResult: assessment.expectedResult,
                        successCriteria: assessment.successCriteria,
                        commonFailures: assessment.commonFailures,
                      })),
                    },
                  })),
                },
              })),
            },
            ...(source.welcome
              ? {
                  welcome: {
                    create: {
                      overviewAssetId: source.welcome.overviewAssetId,
                      overviewHeading: source.welcome.overviewHeading,
                      overviewParagraphs: source.welcome.overviewParagraphs,
                      howItWorksSteps:
                        source.welcome.howItWorksSteps === null
                          ? Prisma.DbNull
                          : source.welcome.howItWorksSteps,
                      finalOutcome: source.welcome.finalOutcome,
                    },
                  },
                }
              : {}),
          },
          include: DRAFT_INCLUDE,
        });
        await this.audit.record(
          {
            actor: { type: AuditActorType.OPERATOR, id: operator },
            action: 'admin.draft.create',
            success: true,
            targetType: 'CourseVersion',
            targetId: created.id,
            metadata: { slug },
          },
          tx,
        );
        return created;
      });
      return { draft, created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.findDraft(course.id);
        if (winner) return { draft: winner, created: false };
      }
      throw error;
    }
  }

  async discardDraft(slug: string, operator: string): Promise<void> {
    const course = await this.prisma.course.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!course) throw new NotFoundException(`课程 ${slug} 不存在`);
    const published = await this.prisma.courseVersion.findFirst({
      where: { courseId: course.id, publishedAt: { not: null } },
      select: { id: true },
    });
    if (!published) {
      throw new ConflictException('未发版课程的草稿不能丢弃');
    }
    const draft = await this.requireDraft(slug);
    await this.prisma.$transaction(async (tx) => {
      await requireUnpublishedVersion(tx, draft.id);
      await tx.courseVersion.delete({ where: { id: draft.id } });
      await this.audit.record(
        {
          actor: { type: AuditActorType.OPERATOR, id: operator },
          action: 'admin.draft.discard',
          success: true,
          targetType: 'CourseVersion',
          targetId: draft.id,
          metadata: { slug },
        },
        tx,
      );
    });
  }

  async requireDraft(slug: string): Promise<DraftVersion> {
    const course = await this.prisma.course.findUnique({
      where: { slug },
      select: { id: true },
    });
    const draft = course ? await this.findDraft(course.id) : null;
    if (!draft) {
      throw new NotFoundException(
        `课程 ${slug} 没有草稿，请先 POST /admin/courses/${slug}/draft 创建`,
      );
    }
    return draft;
  }

  async updateCourse(
    slug: string,
    patchInput: CourseMetaPatch,
    operator: string,
  ): Promise<DraftVersion> {
    const patch = CourseMetaPatchSchema.parse(patchInput);
    const draft = await this.requireDraft(slug);
    const currentMeta = isJsonObject(draft.meta) ? draft.meta : {};
    // meta 存客户端形态（如 'Intermediate'）：发版校验和发版写入都按这个形态解析，枚举映射只在发版时做。
    const meta = { ...currentMeta, ...patch } as Prisma.InputJsonObject;

    return this.prisma.$transaction(async (tx) => {
      await requireUnpublishedVersion(tx, draft.id);
      const updated = await tx.courseVersion.update({
        where: { id: draft.id },
        data: { meta },
        include: DRAFT_INCLUDE,
      });
      await this.audit.record(
        {
          actor: { type: AuditActorType.OPERATOR, id: operator },
          action: 'admin.draft.updateCourse',
          success: true,
          targetType: 'CourseVersion',
          targetId: draft.id,
          metadata: { slug },
        },
        tx,
      );
      return updated;
    });
  }

  async updateWelcome(
    slug: string,
    patchInput: WelcomePatch,
    operator: string,
  ): Promise<DraftVersion> {
    const parsed = WelcomePatchSchema.parse(patchInput);
    const patch: Prisma.CourseWelcomeUncheckedUpdateInput = {
      overviewAssetId: parsed.overviewAssetId,
      overviewHeading: parsed.overviewHeading,
      overviewParagraphs: parsed.overviewParagraphs,
      finalOutcome: parsed.finalOutcome,
    };
    if (Object.hasOwn(parsed, 'howItWorksSteps')) {
      patch.howItWorksSteps =
        parsed.howItWorksSteps === null
          ? Prisma.DbNull
          : parsed.howItWorksSteps;
    }
    const draft = await this.requireDraft(slug);
    await this.prisma.$transaction(async (tx) => {
      await requireUnpublishedVersion(tx, draft.id);
      await tx.courseWelcome.upsert({
        where: { courseVersionId: draft.id },
        create: {
          courseVersionId: draft.id,
          ...patch,
        } as Prisma.CourseWelcomeUncheckedCreateInput,
        update: patch,
      });
      await this.audit.record(
        {
          actor: { type: AuditActorType.OPERATOR, id: operator },
          action: 'admin.draft.updateWelcome',
          success: true,
          targetType: 'CourseVersion',
          targetId: draft.id,
          metadata: { slug },
        },
        tx,
      );
    });
    return (await this.prisma.courseVersion.findUnique({
      where: { id: draft.id },
      include: DRAFT_INCLUDE,
    })) as DraftVersion;
  }

  private findDraft(courseId: string): Promise<DraftVersion | null> {
    return this.prisma.courseVersion.findFirst({
      where: { courseId, publishedAt: null },
      orderBy: { version: 'desc' },
      include: DRAFT_INCLUDE,
    });
  }
}

function isJsonObject(
  value: Prisma.JsonValue | null,
): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
