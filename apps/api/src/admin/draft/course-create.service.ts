import { ConflictException, Injectable } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DRAFT_INCLUDE, type DraftVersion } from './draft-version';

export const CreateCourseSchema = z
  .object({
    slug: z
      .string()
      .min(3)
      .max(60)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    title: z.string().min(1).max(120),
  })
  .strict();

export type CreateCourseInput = z.infer<typeof CreateCourseSchema>;

@Injectable()
export class CourseCreateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    input: CreateCourseInput,
    operator: string,
  ): Promise<DraftVersion> {
    const parsed = CreateCourseSchema.parse(input);
    let courseId: string;
    let draft: DraftVersion;
    try {
      ({ courseId, draft } = await this.prisma.$transaction(async (tx) => {
        const course = await tx.course.create({
          data: {
            slug: parsed.slug,
            title: parsed.title,
            contentId: null,
            published: false,
          },
        });
        const created = await tx.courseVersion.create({
          data: {
            courseId: course.id,
            version: 1,
            publishedAt: null,
            welcome: { create: {} },
          },
          include: DRAFT_INCLUDE,
        });
        return { courseId: course.id, draft: created };
      }));
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`slug 已被占用：${parsed.slug}`);
      }
      throw error;
    }

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.course.create',
      success: true,
      targetType: 'Course',
      targetId: courseId,
      metadata: { slug: parsed.slug },
    });
    return draft;
  }
}

function isUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
