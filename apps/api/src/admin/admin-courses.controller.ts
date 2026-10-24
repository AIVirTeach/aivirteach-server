import {
  CreateAssessmentSchema,
  CourseMetaSchema,
} from '@aivirteach/admin-contract';
import { AdminCourseListService } from './courses/admin-course-list.service';
import { CourseAssetListService } from './assets/course-asset-list.service';
import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MulterError } from 'multer';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildLessonResponse,
  InvalidLessonContentError,
} from '../courses/lesson-response';
import { loadCourseAssets } from '../courses/course-assets';
import { collectImageAssetIds } from '@aivirteach/lesson-blocks';
import { CurrentOperator } from '../operator-auth/current-operator.decorator';
import { OperatorAuthGuard } from '../operator-auth/operator-auth.guard';
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
import { CourseAssetUploadService } from './assets/course-asset-upload.service';

const UploadFileInterceptor = FileInterceptor('file', {
  limits: { fileSize: 5 * 1024 * 1024 },
});

class ChineseAssetUploadInterceptor implements NestInterceptor {
  private readonly delegate = new UploadFileInterceptor();

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      const stream = await this.delegate.intercept(context, next);
      return stream.pipe(
        catchError((error: unknown) => {
          if (isFileSizeLimitError(error)) {
            return throwError(
              () => new BadRequestException('图片大小不能超过 5 MiB'),
            );
          }
          return throwError(() => error);
        }),
      );
    } catch (error) {
      if (isFileSizeLimitError(error)) {
        throw new BadRequestException('图片大小不能超过 5 MiB');
      }
      throw error;
    }
  }
}

function isFileSizeLimitError(error: unknown): boolean {
  return (
    (error instanceof MulterError && error.code === 'LIMIT_FILE_SIZE') ||
    (hasStatusCode(error) && error.getStatus() === 413) ||
    (error instanceof BadRequestException && hasFileTooLargeResponse(error))
  );
}

function hasStatusCode(error: unknown): error is { getStatus: () => number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'getStatus' in error &&
    typeof error.getStatus === 'function'
  );
}

function hasFileTooLargeResponse(error: BadRequestException): boolean {
  const response = error.getResponse();
  const text =
    typeof response === 'string' ? response : (JSON.stringify(response) ?? '');
  return text.includes('File too large');
}

const UploadAssetBodySchema = z.preprocess(
  (body) => body ?? {},
  z.object({ altText: z.string().max(300).optional() }),
);
const PublishBodySchema = z.preprocess(
  (body) => (body === undefined ? {} : body),
  z.object({ reason: z.string().min(1).optional() }).strict(),
);

@ApiTags('Admin Courses')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard)
@Controller('admin/courses/:slug')
export class AdminCoursesController {
  constructor(
    private readonly drafts: CourseDraftService,
    private readonly content: DraftContentService,
    private readonly publishing: CoursePublishService,
    private readonly prisma: PrismaService,
    private readonly assetUploads: CourseAssetUploadService,
    private readonly assetList: CourseAssetListService,
  ) {}

  @Get('assets')
  listAssets(@Param('slug') slug: string) {
    return this.assetList.list(slug);
  }

  @Post('draft')
  async createDraft(
    @Param('slug') slug: string,
    @CurrentOperator() operator: string,
    @Res() response: Response,
  ) {
    const result = await this.drafts.createDraft(slug, operator);
    return response.status(result.created ? 201 : 200).json(result.draft);
  }

  @Get('draft')
  async getDraft(@Param('slug') slug: string) {
    const draft = await this.drafts.requireDraft(slug);
    const course = await this.prisma.course.findUnique({
      where: { id: draft.courseId },
      select: {
        title: true,
        shortTitle: true,
        category: true,
        description: true,
        level: true,
        language: true,
        tags: true,
        outcomes: true,
        requirements: true,
      },
    });
    if (!course) throw new NotFoundException(`课程 ${slug} 不存在`);
    const level = {
      BEGINNER: 'Beginner',
      INTERMEDIATE: 'Intermediate',
      ADVANCED: 'Advanced',
    }[course.level];
    const patch = CourseMetaPatchSchema.parse(draft.meta ?? {});
    return {
      ...draft,
      effectiveMeta: CourseMetaSchema.parse({ ...course, level, ...patch }),
    };
  }

  @Delete('draft')
  discardDraft(
    @Param('slug') slug: string,
    @CurrentOperator() operator: string,
  ) {
    return this.drafts.discardDraft(slug, operator);
  }

  @Patch('draft')
  updateCourse(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(CourseMetaPatchSchema))
    body: z.infer<typeof CourseMetaPatchSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.drafts.updateCourse(slug, body, operator);
  }

  @Patch('draft/welcome')
  updateWelcome(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(WelcomePatchSchema))
    body: z.infer<typeof WelcomePatchSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.drafts.updateWelcome(slug, body, operator);
  }

  @Post('draft/modules')
  createModule(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(CreateModuleSchema))
    body: z.infer<typeof CreateModuleSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.content.createModule(slug, body, operator);
  }

  @Patch('draft/modules/:moduleId')
  updateModule(
    @Param('slug') slug: string,
    @Param('moduleId') moduleId: string,
    @Body(new ZodValidationPipe(UpdateModulePatchSchema))
    body: z.infer<typeof UpdateModulePatchSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.content.updateModule(slug, moduleId, body, operator);
  }

  @Delete('draft/modules/:moduleId')
  deleteModule(
    @Param('slug') slug: string,
    @Param('moduleId') moduleId: string,
    @CurrentOperator() operator: string,
  ) {
    return this.content.deleteModule(slug, moduleId, operator);
  }

  @Post('draft/modules/:moduleId/lessons')
  createLesson(
    @Param('slug') slug: string,
    @Param('moduleId') moduleId: string,
    @Body(new ZodValidationPipe(CreateLessonSchema))
    body: z.infer<typeof CreateLessonSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.content.createLesson(slug, moduleId, body, operator);
  }

  @Patch('draft/lessons/:contentId')
  updateLesson(
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
    @Body(new ZodValidationPipe(UpdateLessonPatchSchema))
    body: z.infer<typeof UpdateLessonPatchSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.content.updateLesson(slug, contentId, body, operator);
  }

  @Delete('draft/lessons/:contentId')
  deleteLesson(
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
    @CurrentOperator() operator: string,
  ) {
    return this.content.deleteLesson(slug, contentId, operator);
  }

  @Put('draft/order')
  reorder(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(ReorderSchema))
    body: z.infer<typeof ReorderSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.content.reorder(slug, body, operator);
  }

  @Post('draft/lessons/:contentId/assessments')
  createAssessment(
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
    @Body(new ZodValidationPipe(CreateAssessmentSchema))
    body: z.infer<typeof CreateAssessmentSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.content.createAssessment(slug, contentId, body, operator);
  }

  @Patch('draft/assessments/:assessmentId')
  updateAssessment(
    @Param('slug') slug: string,
    @Param('assessmentId') assessmentId: string,
    @Body(new ZodValidationPipe(UpdateAssessmentPatchSchema))
    body: z.infer<typeof UpdateAssessmentPatchSchema>,
    @CurrentOperator() operator: string,
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
    try {
      return buildLessonResponse({
        courseSlug: slug,
        courseVersionId: draft.id,
        courseVersion: draft.version,
        modules: draft.modules,
        lessonId: contentId,
        courseAssets,
      });
    } catch (error) {
      if (error instanceof InvalidLessonContentError) {
        throw new UnprocessableEntityException({
          message: '课时内容无法预览',
          problems: error.problems,
        });
      }
      throw error;
    }
  }

  @Post('publish')
  publish(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(PublishBodySchema))
    body: z.infer<typeof PublishBodySchema> = {},
    @CurrentOperator() operator: string,
  ) {
    return this.publishing.publish(
      slug,
      operator,
      body.reason ?? 'admin publish',
    );
  }

  @Post('assets')
  @UseInterceptors(new ChineseAssetUploadInterceptor())
  uploadAsset(
    @Param('slug') slug: string,
    @CurrentOperator() operator: string,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
    @Body(new ZodValidationPipe(UploadAssetBodySchema))
    body: z.infer<typeof UploadAssetBodySchema>,
  ) {
    if (!file) throw new BadRequestException('请上传图片文件');
    return this.assetUploads.upload(slug, file, body.altText, operator);
  }
}

@ApiTags('Admin Courses')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard)
@Controller('admin/courses')
export class AdminCourseCreateController {
  constructor(
    private readonly courses: CourseCreateService,
    private readonly courseList: AdminCourseListService,
  ) {}

  @Get()
  list() {
    return this.courseList.list();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateCourseSchema))
    body: z.infer<typeof CreateCourseSchema>,
    @CurrentOperator() operator: string,
  ) {
    return this.courses.create(body, operator);
  }
}
