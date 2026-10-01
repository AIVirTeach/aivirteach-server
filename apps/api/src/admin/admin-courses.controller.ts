import {
  Body,
  ConflictException,
  Controller,
  createParamDecorator,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { buildLessonResponse } from '../courses/lesson-response';
import { loadCourseAssets } from '../courses/course-assets';
import { collectImageAssetIds } from '@aivirteach/lesson-blocks';
import { AdminApiTokenGuard } from './admin-api-token.guard';
import { OperatorSchema } from './admin.schemas';
import { CourseDraftService } from './draft/course-draft.service';
import {
  CourseMetaPatchSchema,
  CreateLessonSchema,
  CreateModuleSchema,
  ReorderSchema,
  UpdateAssessmentPatchSchema,
  UpdateLessonPatchSchema,
  UpdateModulePatchSchema,
  WelcomePatchSchema,
} from './draft/draft.schemas';
import { DraftContentService } from './draft/draft-content.service';
import { CoursePublishService } from './course-publish.service';
import {
  CourseCreateService,
  CreateCourseSchema,
} from './draft/course-create.service';

const OperatorHeader = createParamDecorator((_data, context) => {
  const request = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string | undefined> }>();
  return request.headers['x-operator'] ?? '';
});
const PublishBodySchema = z.preprocess(
  (body) => (body === undefined ? {} : body),
  z.object({ reason: z.string().min(1).optional() }).strict(),
);

@ApiTags('Admin Courses')
@ApiBearerAuth()
@UseGuards(AdminApiTokenGuard)
@Controller('admin/courses/:slug')
export class AdminCoursesController {
  constructor(
    private readonly drafts: CourseDraftService,
    private readonly content: DraftContentService,
    private readonly publishing: CoursePublishService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('draft')
  async createDraft(
    @Param('slug') slug: string,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
    @Res() response: Response,
  ) {
    const result = await this.drafts.createDraft(slug, operator);
    return response.status(result.created ? 201 : 200).json(result.draft);
  }

  @Get('draft')
  getDraft(@Param('slug') slug: string) {
    return this.drafts.requireDraft(slug);
  }

  @Delete('draft')
  discardDraft(
    @Param('slug') slug: string,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.drafts.discardDraft(slug, operator);
  }

  @Patch('draft')
  updateCourse(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(CourseMetaPatchSchema))
    body: z.infer<typeof CourseMetaPatchSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.drafts.updateCourse(slug, body, operator);
  }

  @Patch('draft/welcome')
  updateWelcome(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(WelcomePatchSchema))
    body: z.infer<typeof WelcomePatchSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.drafts.updateWelcome(slug, body, operator);
  }

  @Post('draft/modules')
  createModule(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(CreateModuleSchema))
    body: z.infer<typeof CreateModuleSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.content.createModule(slug, body, operator);
  }

  @Patch('draft/modules/:moduleId')
  updateModule(
    @Param('slug') slug: string,
    @Param('moduleId') moduleId: string,
    @Body(new ZodValidationPipe(UpdateModulePatchSchema))
    body: z.infer<typeof UpdateModulePatchSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.content.updateModule(slug, moduleId, body, operator);
  }

  @Delete('draft/modules/:moduleId')
  deleteModule(
    @Param('slug') slug: string,
    @Param('moduleId') moduleId: string,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.content.deleteModule(slug, moduleId, operator);
  }

  @Post('draft/modules/:moduleId/lessons')
  createLesson(
    @Param('slug') slug: string,
    @Param('moduleId') moduleId: string,
    @Body(new ZodValidationPipe(CreateLessonSchema))
    body: z.infer<typeof CreateLessonSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.content.createLesson(slug, moduleId, body, operator);
  }

  @Patch('draft/lessons/:contentId')
  updateLesson(
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
    @Body(new ZodValidationPipe(UpdateLessonPatchSchema))
    body: z.infer<typeof UpdateLessonPatchSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.content.updateLesson(slug, contentId, body, operator);
  }

  @Delete('draft/lessons/:contentId')
  deleteLesson(
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.content.deleteLesson(slug, contentId, operator);
  }

  @Put('draft/order')
  reorder(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(ReorderSchema))
    body: z.infer<typeof ReorderSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.content.reorder(slug, body, operator);
  }

  @Patch('draft/assessments/:assessmentId')
  updateAssessment(
    @Param('slug') slug: string,
    @Param('assessmentId') assessmentId: string,
    @Body(new ZodValidationPipe(UpdateAssessmentPatchSchema))
    body: z.infer<typeof UpdateAssessmentPatchSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.content.updateAssessment(slug, assessmentId, body, operator);
  }

  @Get('draft/lessons/:contentId')
  async previewLesson(
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
  ) {
    const draft = await this.drafts.requireDraft(slug);
    const matches = draft.modules.flatMap((courseModule) =>
      courseModule.lessons.filter((lesson) => lesson.contentId === contentId),
    );
    if (matches.length > 1) {
      throw new ConflictException(`contentId ${contentId} 对应多个草稿课时`);
    }
    const assetIds = collectImageAssetIds(matches[0]?.content);
    const courseAssets = await loadCourseAssets(
      this.prisma,
      draft.courseId,
      assetIds,
    );
    return buildLessonResponse({
      courseSlug: slug,
      modules: draft.modules,
      lessonId: contentId,
      courseAssets,
    });
  }

  @Post('publish')
  publish(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(PublishBodySchema))
    body: z.infer<typeof PublishBodySchema> = {},
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.publishing.publish(
      slug,
      operator,
      body.reason ?? 'admin publish',
    );
  }
}

@ApiTags('Admin Courses')
@ApiBearerAuth()
@UseGuards(AdminApiTokenGuard)
@Controller('admin/courses')
export class AdminCourseCreateController {
  constructor(private readonly courses: CourseCreateService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateCourseSchema))
    body: z.infer<typeof CreateCourseSchema>,
    @OperatorHeader(new ZodValidationPipe(OperatorSchema)) operator: string,
  ) {
    return this.courses.create(body, operator);
  }
}
