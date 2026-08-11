import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashOpaqueToken } from '../auth/tokens';
import { AdminService } from './admin.service';

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
  course: { create: jest.fn(), findUnique: jest.fn() },
  courseVersion: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  enrollment: { create: jest.fn() },
  quotaLedger: { create: jest.fn() },
});

const buildService = async (
  prisma: ReturnType<typeof buildPrisma>,
  audit = { record: jest.fn() },
) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { service: moduleRef.get(AdminService), audit };
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

    const result = await service.inviteUser('new@example.com', OPERATOR, REASON);

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

describe('AdminService.createCourse / publishCourse', () => {
  it('创建课程时一并建第一个 CourseVersion（version=1，未发布）', async () => {
    const prisma = buildPrisma();
    prisma.course.create.mockResolvedValue({
      id: 'course_1',
      slug: 'n8n',
      title: 'n8n 自动化工作流',
      versions: [{ id: 'cv_1', version: 1, publishedAt: null }],
    });
    const { service, audit } = await buildService(prisma);

    await service.createCourse('n8n', 'n8n 自动化工作流', OPERATOR, REASON);

    expect(prisma.course.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'n8n',
          title: 'n8n 自动化工作流',
          versions: { create: { version: 1, imageDigest: null } },
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.createCourse', success: true }),
    );
  });

  it('发布课程时给最新版本写 publishedAt', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue({
      id: 'cv_1',
      courseId: 'course_1',
      version: 1,
      publishedAt: null,
    });
    prisma.courseVersion.update.mockResolvedValue({
      id: 'cv_1',
      publishedAt: new Date(),
    });
    const { service, audit } = await buildService(prisma);

    await service.publishCourse('n8n', OPERATOR, REASON);

    expect(prisma.courseVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cv_1' },
        data: expect.objectContaining({ publishedAt: expect.any(Date) }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.publishCourse',
        targetType: 'CourseVersion',
        targetId: 'cv_1',
      }),
    );
  });

  it('重复发布同一版本是幂等的，不会二次写 publishedAt', async () => {
    const prisma = buildPrisma();
    const already = { id: 'cv_1', courseId: 'course_1', version: 1, publishedAt: new Date() };
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue(already);
    const { service } = await buildService(prisma);

    const result = await service.publishCourse('n8n', OPERATOR, REASON);

    expect(prisma.courseVersion.update).not.toHaveBeenCalled();
    expect(result).toBe(already);
  });

  it('课程没有任何版本时发布抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(service.publishCourse('n8n', OPERATOR, REASON)).rejects.toBeInstanceOf(
      NotFoundException,
    );
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
    prisma.user.findUnique.mockResolvedValue({ id: 'user_1', email: 'a@b.com' });
    prisma.quotaLedger.create.mockResolvedValue({
      id: 'ledger_1',
      userId: 'user_1',
      minutesDelta: 120,
    });
    const { service, audit } = await buildService(prisma);

    const entry = await service.grantQuota('a@b.com', 120, OPERATOR, REASON);

    expect(entry.minutesDelta).toBe(120);
    expect(prisma.quotaLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: 'user_1', minutesDelta: 120 } }),
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
