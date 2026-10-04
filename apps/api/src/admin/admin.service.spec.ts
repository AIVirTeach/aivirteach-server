import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashOpaqueToken } from '../auth/tokens';
import { CourseAssetStorageService } from '../courses/course-asset-storage.service';
import { CourseIngestionService } from '../courses/course-ingestion.service';
import { AdminService } from './admin.service';
import { CoursePublishService } from './course-publish.service';

const VALID_IMAGE_FIXTURE = join(
  __dirname,
  '../courses/__fixtures__/sample-course/cover.png',
);
const NOT_AN_IMAGE_FIXTURE = join(__dirname, '__fixtures__/not-an-image.txt');

const ENV_STUB = {
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: 'a'.repeat(48),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 3000,
  CORS_ORIGINS: 'tauri://localhost',
};

const buildPrisma = () => ({
  user: { upsert: jest.fn(), findUnique: jest.fn() },
  invitation: { create: jest.fn().mockResolvedValue({ id: 'inv_1' }) },
  course: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  courseVersion: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  courseAsset: { create: jest.fn() },
  enrollment: { create: jest.fn() },
  quotaLedger: { create: jest.fn() },
});

const buildCourseIngestion = () => ({
  ingestFromDirectory: jest.fn(),
  previewConversions: jest.fn(),
});

const buildCourseAssetStorage = () => ({
  upload: jest
    .fn()
    .mockResolvedValue(
      'https://blob.vercel-storage.com/courses/sample/cover.png',
    ),
});

const buildService = async (
  prisma: ReturnType<typeof buildPrisma>,
  audit = { record: jest.fn() },
  courseIngestion = buildCourseIngestion(),
  courseAssetStorage = buildCourseAssetStorage(),
  coursePublish = { publish: jest.fn() },
) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
      { provide: AuditService, useValue: audit },
      { provide: CourseIngestionService, useValue: courseIngestion },
      { provide: CourseAssetStorageService, useValue: courseAssetStorage },
      { provide: CoursePublishService, useValue: coursePublish },
    ],
  }).compile();
  return { service: moduleRef.get(AdminService), audit, courseAssetStorage };
};

const OPERATOR = 'ops@example.com';
const REASON = '封测名单批次 1';

describe('AdminService.inviteUser', () => {
  it('返回明文邀请码，但落库的是它的哈希，并写入审计', async () => {
    const prisma = buildPrisma();
    prisma.user.upsert.mockResolvedValue({
      id: 'user_1',
      email: 'new@example.com',
    });
    const { service, audit } = await buildService(prisma);

    const result = await service.inviteUser(
      'new@example.com',
      OPERATOR,
      REASON,
    );

    expect(result.invitationToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(prisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          tokenHash: hashOpaqueToken(result.invitationToken),
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: AuditActorType.OPERATOR, id: OPERATOR },
        action: 'admin.inviteUser',
        success: true,
        targetType: 'User',
        targetId: 'user_1',
        reason: REASON,
      }),
    );
  });

  it('重复邀请同一邮箱不会新建用户（upsert）', async () => {
    const prisma = buildPrisma();
    prisma.user.upsert.mockResolvedValue({
      id: 'user_1',
      email: 'dup@example.com',
    });
    const { service } = await buildService(prisma);

    await service.inviteUser('dup@example.com', OPERATOR, REASON);

    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'dup@example.com' } }),
    );
  });
});

describe('AdminService.createCourse', () => {
  it('调用摄取服务，并记审计', async () => {
    const prisma = buildPrisma();
    const courseIngestion = buildCourseIngestion();
    courseIngestion.ingestFromDirectory.mockResolvedValue({
      id: 'course_1',
      slug: 'n8n',
      title: 'n8n 自动化工作流',
      versions: [{ version: 1 }],
    });
    const { service, audit } = await buildService(
      prisma,
      undefined,
      courseIngestion,
    );

    const course = await service.createCourse(
      '/content/n8n',
      OPERATOR,
      REASON,
      'sha256:abc',
    );

    expect(courseIngestion.ingestFromDirectory).toHaveBeenCalledWith(
      '/content/n8n',
      'sha256:abc',
    );
    expect(course.slug).toBe('n8n');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.createCourse',
        targetId: 'course_1',
      }),
    );
  });
});

describe('AdminService.previewCourseConversions', () => {
  it('委托摄取服务生成 dry-run 转换报告，不写库也不记审计', async () => {
    const courseIngestion = buildCourseIngestion();
    const reports = [{ lessonContentId: 'lesson-1', issues: [] }];
    courseIngestion.previewConversions.mockResolvedValue(reports);
    const { service, audit } = await buildService(
      buildPrisma(),
      undefined,
      courseIngestion,
    );

    await expect(
      service.previewCourseConversions('/content/n8n'),
    ).resolves.toEqual(reports);

    expect(courseIngestion.previewConversions).toHaveBeenCalledWith(
      '/content/n8n',
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('AdminService.publishCourse', () => {
  it('delegates publishing to CoursePublishService', async () => {
    const coursePublish = {
      publish: jest.fn().mockResolvedValue({ id: 'cv_1' }),
    };
    const { service } = await buildService(
      buildPrisma(),
      undefined,
      undefined,
      undefined,
      coursePublish,
    );

    await expect(
      service.publishCourse('n8n', OPERATOR, REASON),
    ).resolves.toEqual({ id: 'cv_1' });
    expect(coursePublish.publish).toHaveBeenCalledWith('n8n', OPERATOR, REASON);
  });
});

describe('AdminService 其余运营操作', () => {
  it('给不存在的用户发额度抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(
      service.grantQuota('ghost@example.com', 120, OPERATOR, REASON),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('给不存在的课程选课抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'user_1' });
    prisma.course.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(
      service.enrollUser('a@b.com', 'no-such-course', OPERATOR, REASON),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('发放额度写入 QuotaLedger 的正数流水，并带审计', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'a@b.com',
    });
    prisma.quotaLedger.create.mockResolvedValue({
      id: 'ledger_1',
      userId: 'user_1',
      minutesDelta: 120,
    });
    const { service, audit } = await buildService(prisma);

    const entry = await service.grantQuota('a@b.com', 120, OPERATOR, REASON);

    expect(entry.minutesDelta).toBe(120);
    expect(prisma.quotaLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { userId: 'user_1', minutesDelta: 120 },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: AuditActorType.OPERATOR, id: OPERATOR },
        action: 'admin.grantQuota',
        targetType: 'QuotaLedger',
        targetId: 'ledger_1',
      }),
    );
  });
});

describe('AdminService.setCourseCover', () => {
  it('课程不存在时抛 NotFoundException，不会去读文件或上传', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue(null);
    const courseAssetStorage = buildCourseAssetStorage();
    const { service } = await buildService(
      prisma,
      undefined,
      undefined,
      courseAssetStorage,
    );

    await expect(
      service.setCourseCover(
        'no-such-course',
        VALID_IMAGE_FIXTURE,
        OPERATOR,
        REASON,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(courseAssetStorage.upload).not.toHaveBeenCalled();
  });

  it('文件不是受支持的图片格式时抛 BadRequestException，不会上传也不会写库', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_1',
      slug: 'sample',
      title: 'Sample',
    });
    const courseAssetStorage = buildCourseAssetStorage();
    const { service } = await buildService(
      prisma,
      undefined,
      undefined,
      courseAssetStorage,
    );

    await expect(
      service.setCourseCover('sample', NOT_AN_IMAGE_FIXTURE, OPERATOR, REASON),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(courseAssetStorage.upload).not.toHaveBeenCalled();
    expect(prisma.courseAsset.create).not.toHaveBeenCalled();
  });

  it('上传真实图片：建 CourseAsset、回填 Course.coverAssetId、写审计', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_1',
      slug: 'sample',
      title: 'Sample Course',
    });
    prisma.courseAsset.create.mockResolvedValue({
      id: 'asset_1',
      courseId: 'course_1',
      type: 'cover',
      objectKey: 'https://blob.vercel-storage.com/courses/sample/cover.png',
      altText: 'Sample Course 封面',
    });
    const courseAssetStorage = buildCourseAssetStorage();
    const { service, audit } = await buildService(
      prisma,
      undefined,
      undefined,
      courseAssetStorage,
    );

    const asset = await service.setCourseCover(
      'sample',
      VALID_IMAGE_FIXTURE,
      OPERATOR,
      REASON,
    );

    expect(courseAssetStorage.upload).toHaveBeenCalledWith(
      'courses/sample/cover.png',
      VALID_IMAGE_FIXTURE,
    );
    expect(prisma.courseAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          courseId: 'course_1',
          type: 'cover',
          objectKey: 'https://blob.vercel-storage.com/courses/sample/cover.png',
        }),
      }),
    );
    expect(prisma.course.update).toHaveBeenCalledWith({
      where: { id: 'course_1' },
      data: { coverAssetId: 'asset_1' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: AuditActorType.OPERATOR, id: OPERATOR },
        action: 'admin.setCourseCover',
        success: true,
        targetType: 'CourseAsset',
        targetId: 'asset_1',
        reason: REASON,
      }),
    );
    expect(asset.id).toBe('asset_1');
  });
});

describe('AdminService.grantTokenQuota', () => {
  it('给不存在的用户发 token 额度抛 NotFoundException，不写账本', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(
      service.grantTokenQuota('ghost@example.com', 1_000_000, OPERATOR, REASON),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.quotaLedger.create).not.toHaveBeenCalled();
  });

  it('写入 QuotaLedger 的 tokensDelta 正数流水（minutesDelta 留默认 0），并带审计', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'a@b.com',
    });
    prisma.quotaLedger.create.mockResolvedValue({
      id: 'ledger_2',
      userId: 'user_1',
      minutesDelta: 0,
      tokensDelta: 1_000_000,
    });
    const { service, audit } = await buildService(prisma);

    const entry = await service.grantTokenQuota(
      'a@b.com',
      1_000_000,
      OPERATOR,
      REASON,
    );

    expect(entry.tokensDelta).toBe(1_000_000);
    expect(prisma.quotaLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { userId: 'user_1', tokensDelta: 1_000_000 },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: AuditActorType.OPERATOR, id: OPERATOR },
        action: 'admin.grantTokenQuota',
        targetType: 'QuotaLedger',
        targetId: 'ledger_2',
        reason: REASON,
      }),
    );
  });
});
