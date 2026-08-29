import { readFile } from 'node:fs/promises';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Course,
  CourseAsset,
  CourseVersion,
  Enrollment,
  QuotaLedger,
} from '@prisma/client';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { CourseAssetStorageService } from '../courses/course-asset-storage.service';
import { CourseIngestionService } from '../courses/course-ingestion.service';
import {
  detectImageExtension,
  MAX_COVER_IMAGE_BYTES,
} from './course-cover-image';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InviteResult {
  userId: string;
  email: string;
  invitationToken: string;
  expiresAt: Date;
}

// 封测期所有「开通」动作都走这里。将来 Admin API 接进来时复用同一套规则，
// 不要在 controller 里另写一份。每个写操作都要求调用方传 operator/reason，
// 由这里统一转成 AuditEvent——业务表本身不重复存这两个字段。
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly courseIngestion: CourseIngestionService,
    private readonly courseAssetStorage: CourseAssetStorageService,
  ) {}

  async inviteUser(
    email: string,
    operator: string,
    reason: string,
  ): Promise<InviteResult> {
    const user = await this.prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });

    const invitationToken = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + this.env.INVITATION_TTL_DAYS * DAY_MS,
    );

    await this.prisma.invitation.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(invitationToken),
        expiresAt,
      },
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.inviteUser',
      success: true,
      targetType: 'User',
      targetId: user.id,
      reason,
    });

    // 明文只在这里返回一次，之后无法再取回。
    return { userId: user.id, email: user.email, invitationToken, expiresAt };
  }

  async createCourse(
    contentDir: string,
    operator: string,
    reason: string,
    imageDigest?: string,
  ): Promise<Course & { versions: CourseVersion[] }> {
    const course = await this.courseIngestion.ingestFromDirectory(
      contentDir,
      imageDigest,
    );

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.createCourse',
      success: true,
      targetType: 'Course',
      targetId: course.id,
      reason,
    });

    return course;
  }

  async setCourseCover(
    slug: string,
    filePath: string,
    operator: string,
    reason: string,
  ): Promise<CourseAsset> {
    const course = await this.requireCourse(slug);

    const buffer = await readFile(filePath);
    if (buffer.length > MAX_COVER_IMAGE_BYTES) {
      throw new BadRequestException(
        `封面图片超过大小上限（${MAX_COVER_IMAGE_BYTES / (1024 * 1024)}MB）：${filePath}`,
      );
    }
    const extension = detectImageExtension(buffer);
    if (!extension) {
      throw new BadRequestException(
        `文件不是受支持的图片格式（PNG/JPEG/GIF/WEBP）：${filePath}`,
      );
    }

    const objectKey = await this.courseAssetStorage.upload(
      `courses/${slug}/cover${extension}`,
      filePath,
    );

    const asset = await this.prisma.courseAsset.create({
      data: {
        courseId: course.id,
        type: 'cover',
        objectKey,
        altText: `${course.title} 封面`,
      },
    });

    await this.prisma.course.update({
      where: { id: course.id },
      data: { coverAssetId: asset.id },
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.setCourseCover',
      success: true,
      targetType: 'CourseAsset',
      targetId: asset.id,
      reason,
    });

    return asset;
  }

  async publishCourse(
    slug: string,
    operator: string,
    reason: string,
  ): Promise<CourseVersion> {
    const course = await this.requireCourse(slug);
    const latest = await this.prisma.courseVersion.findFirst({
      where: { courseId: course.id },
      orderBy: { version: 'desc' },
    });
    if (!latest) {
      throw new NotFoundException(`课程 ${slug} 还没有任何版本`);
    }

    // 已经发布过就直接返回，不二次写 publishedAt——发布本身要是幂等操作。
    const published = latest.publishedAt
      ? latest
      : await this.prisma.courseVersion.update({
          where: { id: latest.id },
          data: { publishedAt: new Date() },
        });

    if (!course.published) {
      await this.prisma.course.update({
        where: { id: course.id },
        data: { published: true },
      });
    }

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.publishCourse',
      success: true,
      targetType: 'CourseVersion',
      targetId: published.id,
      reason,
    });

    return published;
  }

  async enrollUser(
    email: string,
    courseSlug: string,
    operator: string,
    reason: string,
  ): Promise<Enrollment> {
    const user = await this.requireUser(email);
    const course = await this.requireCourse(courseSlug);

    const enrollment = await this.prisma.enrollment.create({
      data: { userId: user.id, courseId: course.id },
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.enrollUser',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
      reason,
    });

    return enrollment;
  }

  async grantQuota(
    email: string,
    minutes: number,
    operator: string,
    reason: string,
  ): Promise<QuotaLedger> {
    const user = await this.requireUser(email);

    const entry = await this.prisma.quotaLedger.create({
      data: { userId: user.id, minutesDelta: minutes },
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.grantQuota',
      success: true,
      targetType: 'QuotaLedger',
      targetId: entry.id,
      reason,
    });

    return entry;
  }

  private async requireUser(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new NotFoundException(`找不到用户：${email}`);
    }
    return user;
  }

  private async requireCourse(slug: string) {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course) {
      throw new NotFoundException(`找不到课程：${slug}`);
    }
    return course;
  }
}
