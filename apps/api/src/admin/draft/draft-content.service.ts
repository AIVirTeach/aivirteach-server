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
  validateLessonContent,
  type ValidationReport,
} from '@aivirteach/lesson-blocks';
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
import {
  DRAFT_INCLUDE,
  requireUnpublishedVersion,
  type DraftVersion,
} from './draft-version';

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
      const remaining = draft.modules
        .filter((item) => item.position > module.position)
        .sort((a, b) => a.position - b.position);
      await tx.courseModule.updateMany({
        where: { courseVersionId: draft.id, position: { gt: module.position } },
        data: { position: { increment: POSITION_OFFSET } },
      });
      for (const sibling of remaining) {
        await tx.courseModule.update({
          where: { id: sibling.id },
          data: { position: sibling.position - 1 },
        });
      }
    });
  }

  async createLesson(
    slug: string,
    moduleId: string,
    input: CreateLessonInput,
    operator: string,
  ): Promise<{ draft: DraftVersion; problems: ValidationReport }> {
    const data = CreateLessonSchema.parse(input);
    const content =
      data.content === undefined
        ? { schemaVersion: 1 as const, blocks: [] }
        : data.content;
    assertWritableContent(content);
    const draft = await this.drafts.requireDraft(slug);
    const courseAssetIds = await this.courseAssetIds(draft.courseId);
    const problems = validateLessonContent(content, { courseAssetIds });
    const updatedDraft = await this.mutate(
      slug,
      draft,
      operator,
      'createLesson',
      async (tx) => {
        const module = await tx.courseModule.findFirst({
          where: { id: moduleId, courseVersionId: draft.id },
          select: { id: true },
        });
        if (!module) throw new NotFoundException(`草稿模块 ${moduleId} 不存在`);
        // contentId 在整个草稿内唯一：跨模块重复会让之后按 contentId 的 PATCH/DELETE/reorder 全部 409。
        const duplicate = await tx.courseLesson.findFirst({
          where: {
            contentId: data.contentId,
            module: { courseVersionId: draft.id },
          },
          select: { id: true },
        });
        if (duplicate)
          throw new ConflictException(`草稿中已存在课时 ${data.contentId}`);
        const last = await tx.courseLesson.findFirst({
          where: { moduleId },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        const { activity, content: _unused, ...lesson } = data;
        void _unused;
        await tx.courseLesson.create({
          data: {
            ...lesson,
            body: '',
            content: content as Prisma.InputJsonValue,
            objectives: lesson.objectives ?? [],
            moduleId,
            position: (last?.position ?? 0) + 1,
            activityType: activity.type,
            activityPrompt: activity.prompt,
            activityCompletionType: activity.completionType,
          },
        });
      },
    );
    return { draft: updatedDraft, problems };
  }

  async updateLesson(
    slug: string,
    contentId: string,
    patchInput: UpdateLessonPatch,
    operator: string,
  ): Promise<{ draft: DraftVersion; problems: ValidationReport }> {
    const patch = UpdateLessonPatchSchema.parse(patchInput);
    const draft = await this.drafts.requireDraft(slug);
    const lesson = this.findLesson(draft, contentId);
    let problems: ValidationReport | undefined;
    if (patch.content !== undefined) {
      assertWritableContent(patch.content);
      const courseAssetIds = await this.courseAssetIds(draft.courseId);
      problems = validateLessonContent(patch.content, { courseAssetIds });
    }
    const updatedDraft = await this.mutate(
      slug,
      draft,
      operator,
      'updateLesson',
      async (tx) => {
        const { activity, content, ...fields } = patch;
        await tx.courseLesson.update({
          where: { id: lesson.id },
          data: {
            ...fields,
            ...(content === undefined
              ? {}
              : { content: content as Prisma.InputJsonValue }),
            ...(activity
              ? {
                  activityType: activity.type,
                  activityPrompt: activity.prompt,
                  activityCompletionType: activity.completionType,
                }
              : {}),
          },
        });
      },
    );
    return {
      draft: updatedDraft,
      problems: problems ?? { errors: [], warnings: [] },
    };
  }

  private async courseAssetIds(courseId: string): Promise<Set<string>> {
    const assets = await this.prisma.courseAsset.findMany({
      where: { courseId },
      select: { id: true },
    });
    return new Set(assets.map(({ id }) => id));
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
      const remaining = draft.modules
        .find((module) => module.id === lesson.moduleId)!
        .lessons.filter((item) => item.position > lesson.position)
        .sort((a, b) => a.position - b.position);
      await tx.courseLesson.updateMany({
        where: { moduleId: lesson.moduleId, position: { gt: lesson.position } },
        data: { position: { increment: POSITION_OFFSET } },
      });
      for (const sibling of remaining) {
        await tx.courseLesson.update({
          where: { id: sibling.id },
          data: { position: sibling.position - 1 },
        });
      }
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
      await requireUnpublishedVersion(tx, draft.id);
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
      return updated;
    });
  }
}

function assertWritableContent(
  content: unknown,
): asserts content is Record<string, unknown> {
  if (
    typeof content !== 'object' ||
    content === null ||
    Array.isArray(content)
  ) {
    throw new BadRequestException('课时内容必须是 JSON 对象');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(content);
  } catch {
    throw new BadRequestException('课时内容必须是有效 JSON');
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > 256 * 1024
  ) {
    throw new BadRequestException('课时内容不能超过 256 KB');
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
