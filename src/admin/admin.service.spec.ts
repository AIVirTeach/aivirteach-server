import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
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
  course: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  enrollment: { create: jest.fn() },
  quotaGrant: { create: jest.fn() },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
    ],
  }).compile();
  return moduleRef.get(AdminService);
};

describe('AdminService.inviteUser', () => {
  it('返回明文邀请码，但落库的是它的哈希', async () => {
    const prisma = buildPrisma();
    prisma.user.upsert.mockResolvedValue({
      id: 'user_1',
      email: 'new@example.com',
    });
    const service = await buildService(prisma);

    const result = await service.inviteUser('new@example.com');

    expect(result.invitationToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(prisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          tokenHash: hashOpaqueToken(result.invitationToken),
        }),
      }),
    );
  });

  it('重复邀请同一邮箱不会新建用户（upsert）', async () => {
    const prisma = buildPrisma();
    prisma.user.upsert.mockResolvedValue({
      id: 'user_1',
      email: 'dup@example.com',
    });
    const service = await buildService(prisma);

    await service.inviteUser('dup@example.com');

    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'dup@example.com' } }),
    );
  });
});

describe('AdminService 其余运营操作', () => {
  it('给不存在的用户发额度抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(
      service.grantQuota('ghost@example.com', 120),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('给不存在的课程选课抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'user_1' });
    prisma.course.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(
      service.enrollUser('a@b.com', 'no-such-course'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('发布课程时写入 publishedAt', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.course.update.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    const service = await buildService(prisma);

    await service.publishCourse('n8n');

    expect(prisma.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'course_1' },
        data: expect.objectContaining({ publishedAt: expect.any(Date) }),
      }),
    );
  });
});
