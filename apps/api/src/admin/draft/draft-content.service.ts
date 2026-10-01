import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseDraftService } from './course-draft.service';
import {
  CreateLessonSchema,
  CreateModuleSchema,
  ReorderSchema,
  UpdateAssessmentPatchSchema,
  UpdateLessonPatchSchema,
  UpdateModulePatchSchema,
  type CreateLessonInput,
  type CreateModuleInput,
  type ReorderInput,
  type UpdateAssessmentPatch,
  type UpdateLessonPatch,
  type UpdateModulePatch,
} from './draft.schemas';
import { DRAFT_INCLUDE, type DraftVersion } from './draft-version';

const POSITION_OFFSET = 1_000_000;

@Injectable()
export class DraftContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: CourseDraftService,
    private readonly audit: AuditService,
  ) {}

  async createModule(
    slug: string,
    input: CreateModuleInput,
    operator: string,
  ): Promise<DraftVersion> {
    const data = CreateModuleSchema.parse(input);
    const draft = await this.drafts.requireDraft(slug);
    return this.mutate(slug, draft, operator, 'createModule', async (tx) => {
      const last = await tx.courseModule.findFirst({
        where: { courseVersionId: draft.id },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      await tx.courseModule.create({
        data: {
          ...data,
          courseVersionId: draft.id,
          position: (last?.position ?? 0) + 1,
        },
      });
    });
  }

  async updateModule(
    slug: string,
    moduleId: string,
    patchInput: UpdateModulePatch,
    operator: string,
  ): Promise<DraftVersion> {
    const patch = UpdateModulePatchSchema.parse(patchInput);
    const draft = await this.drafts.requireDraft(slug);
    return this.mutate(slug, draft, operator, 'updateModule', async (tx) => {
      const module = await tx.courseModule.findFirst({
        where: { id: moduleId, courseVersionId: draft.id },
        select: { id: true },
      });
      if (!module) throw new NotFoundException(`草稿模块 ${moduleId} 不存在`);
      await tx.courseModule.update({ where: { id: moduleId }, data: patch });
    });
  }

  async deleteModule(
    slug: string,
    moduleId: string,
    operator: string,
  ): Promise<DraftVersion> {
    const draft = await this.drafts.requireDraft(slug);
    return this.mutate(slug, draft, operator, 'deleteModule', async (tx) => {
      const module = await tx.courseModule.findFirst({
        where: { id: moduleId, courseVersionId: draft.id },
        select: { id: true, position: true },
      });
      if (!module) throw new NotFoundException(`草稿模块 ${moduleId} 不存在`);
      await tx.courseModule.delete({ where: { id: moduleId } });
      await tx.courseModule.updateMany({
        where: { courseVersionId: draft.id, position: { gt: module.position } },
        data: { position: { decrement: 1 } },
      });
    });
  }

  async createLesson(
    slug: string,
    moduleId: string,
    input: CreateLessonInput,
    operator: string,
  ): Promise<DraftVersion> {
    const data = CreateLessonSchema.parse(input);
    const draft = await this.drafts.requireDraft(slug);
    return this.mutate(slug, draft, operator, 'createLesson', async (tx) => {
      const module = await tx.courseModule.findFirst({
        where: { id: moduleId, courseVersionId: draft.id },
        select: { id: true },
      });
      if (!module) throw new NotFoundException(`草稿模块 ${moduleId} 不存在`);
      const duplicate = await tx.courseLesson.findFirst({
        where: { moduleId, contentId: data.contentId },
        select: { id: true },
      });
      if (duplicate)
        throw new ConflictException(`模块中已存在课时 ${data.contentId}`);
      const last = await tx.courseLesson.findFirst({
        where: { moduleId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const { activity, ...lesson } = data;
      await tx.courseLesson.create({
        data: {
          ...lesson,
          body: lesson.body ?? '',
          objectives: lesson.objectives ?? [],
          moduleId,
          position: (last?.position ?? 0) + 1,
          activityType: activity.type,
          activityPrompt: activity.prompt,
          activityCompletionType: activity.completionType,
        },
      });
    });
  }

  async updateLesson(
    slug: string,
    contentId: string,
    patchInput: UpdateLessonPatch,
    operator: string,
  ): Promise<DraftVersion> {
    const patch = UpdateLessonPatchSchema.parse(patchInput);
    const draft = await this.drafts.requireDraft(slug);
    const lesson = this.findLesson(draft, contentId);
    return this.mutate(slug, draft, operator, 'updateLesson', async (tx) => {
      const { activity, ...fields } = patch;
      await tx.courseLesson.update({
        where: { id: lesson.id },
        data: {
          ...fields,
          ...(activity
            ? {
                activityType: activity.type,
                activityPrompt: activity.prompt,
                activityCompletionType: activity.completionType,
              }
            : {}),
        },
      });
    });
  }

  async deleteLesson(
    slug: string,
    contentId: string,
    operator: string,
  ): Promise<DraftVersion> {
    const draft = await this.drafts.requireDraft(slug);
    const lesson = this.findLesson(draft, contentId);
    return this.mutate(slug, draft, operator, 'deleteLesson', async (tx) => {
      await tx.courseLesson.delete({ where: { id: lesson.id } });
      await tx.courseLesson.updateMany({
        where: { moduleId: lesson.moduleId, position: { gt: lesson.position } },
        data: { position: { decrement: 1 } },
      });
    });
  }

  async reorder(
    slug: string,
    input: ReorderInput,
    operator: string,
  ): Promise<DraftVersion> {
    const order = ReorderSchema.parse(input);
    const draft = await this.drafts.requireDraft(slug);
    const modules = draft.modules;
    assertPermutation(
      order.modules.map((item) => item.id),
      modules.map((module) => module.id),
      '模块',
    );
    const lessons = modules.flatMap((module) =>
      module.lessons.map((lesson) => ({
        ...lesson,
        moduleTitle: module.title,
      })),
    );
    const contentIds = order.modules.flatMap((module) => module.lessons);
    if (new Set(contentIds).size !== contentIds.length)
      throw new BadRequestException('重排课时不能重复');
    assertPermutation(
      contentIds,
      lessons.map((lesson) => lesson.contentId),
      '课时',
    );
    if (
      lessons.some(
        (lesson) =>
          lessons.filter((item) => item.contentId === lesson.contentId).length >
          1,
      )
    ) {
      throw new ConflictException(
        `草稿中存在重复 contentId：${[...new Set(lessons.filter((lesson, i) => lessons.findIndex((item) => item.contentId === lesson.contentId) !== i).map((lesson) => lesson.contentId))].join(', ')}`,
      );
    }
    const lessonByContentId = new Map(
      lessons.map((lesson) => [lesson.contentId, lesson]),
    );
    return this.mutate(slug, draft, operator, 'reorder', async (tx) => {
      await tx.courseModule.updateMany({
        where: { courseVersionId: draft.id },
        data: { position: { increment: POSITION_OFFSET } },
      });
      for (const [index, item] of order.modules.entries()) {
        await tx.courseModule.update({
          where: { id: item.id },
          data: { position: index + 1 },
        });
      }
      await tx.courseLesson.updateMany({
        where: { moduleId: { in: modules.map((module) => module.id) } },
        data: { position: { increment: POSITION_OFFSET } },
      });
      // Temporary IDs free the per-module unique constraint while lessons move between modules.
      for (const lesson of lessons) {
        await tx.courseLesson.update({
          where: { id: lesson.id },
          data: { contentId: `reorder-${draft.id}-${lesson.id}` },
        });
      }
      for (const item of order.modules) {
        for (const [index, id] of item.lessons.entries()) {
          const lesson = lessonByContentId.get(id)!;
          await tx.courseLesson.update({
            where: { id: lesson.id },
            data: { moduleId: item.id, position: index + 1, contentId: id },
          });
        }
      }
    });
  }

  async updateAssessment(
    slug: string,
    assessmentId: string,
    patchInput: UpdateAssessmentPatch,
    operator: string,
  ): Promise<DraftVersion> {
    const patch = UpdateAssessmentPatchSchema.parse(patchInput);
    const draft = await this.drafts.requireDraft(slug);
    return this.mutate(
      slug,
      draft,
      operator,
      'updateAssessment',
      async (tx) => {
        const result = await tx.lessonAssessment.updateMany({
          where: {
            id: assessmentId,
            lesson: { module: { courseVersionId: draft.id } },
          },
          data: patch,
        });
        if (result.count === 0)
          throw new NotFoundException(`草稿评估 ${assessmentId} 不存在`);
      },
    );
  }

  private findLesson(draft: DraftVersion, contentId: string) {
    const matches = draft.modules.flatMap((module) =>
      module.lessons
        .filter((lesson) => lesson.contentId === contentId)
        .map((lesson) => ({ ...lesson, moduleTitle: module.title })),
    );
    if (!matches.length)
      throw new NotFoundException(`草稿课时 ${contentId} 不存在`);
    if (matches.length > 1)
      throw new ConflictException(
        `contentId ${contentId} 对应多个模块：${matches.map((item) => item.moduleTitle).join('、')}`,
      );
    return {
      ...matches[0],
      moduleId: draft.modules.find((module) =>
        module.lessons.some((item) => item.id === matches[0].id),
      )!.id,
    };
  }

  private async mutate(
    slug: string,
    draft: DraftVersion,
    operator: string,
    method: string,
    write: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<DraftVersion> {
    return this.prisma.$transaction(async (tx) => {
      await write(tx);
      const updated = await tx.courseVersion.findUnique({
        where: { id: draft.id },
        include: DRAFT_INCLUDE,
      });
      if (!updated) throw new NotFoundException(`草稿 ${slug} 不存在`);
      await this.audit.record(
        {
          actor: { type: AuditActorType.OPERATOR, id: operator },
          action: `admin.draft.${method}`,
          success: true,
          targetType: 'CourseVersion',
          targetId: draft.id,
          metadata: { slug },
        },
        tx,
      );
      return updated as DraftVersion;
    });
  }
}

function assertPermutation(
  actual: string[],
  expected: string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((id) => !expected.includes(id))
  ) {
    throw new BadRequestException(`${label}必须是草稿现有条目的完整排列`);
  }
}
