import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, WorkspaceStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { LabsClient } from '../src/workspace/labs-client';
import { signAccessToken } from '../src/auth/tokens';

// 需要 docker compose up -d 且已执行 prisma migrate。LabsClient.stopVm/startVm 用
// jest.spyOn 替身——重点是验证真实 HTTP 请求经过 Nest 的 Pipe/Guard 管线后能不能正确
// 落到 service（单测里 controller 方法是直接调用的，完全绕过管线，见本次手工验证时
// 发现的 bug：stop() 方法级 @UsePipes 把 enrollmentId 这个字符串参数也塞进了
// StopWorkspaceSchema.safeParse，只有真实过一遍 Nest 管线才会暴露）。
describe('Workspace 端到端', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const jwtSecret = process.env.JWT_SECRET ?? '';
  const email = `workspace-e2e-${Date.now()}@example.com`;
  const otherEmail = `workspace-e2e-other-${Date.now()}@example.com`;
  const courseSlug = `workspace-e2e-course-${Date.now()}`;
  let enrollmentId: string;
  let courseId: string;
  let accessToken: string;
  let otherAccessToken: string;
  let stopVmSpy: jest.SpyInstance;
  let startVmSpy: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    const user = await prisma.user.create({ data: { email } });
    const otherUser = await prisma.user.create({ data: { email: otherEmail } });
    const course = await prisma.course.create({ data: { slug: courseSlug, title: '测试课程', published: true } });
    courseId = course.id;
    const enrollment = await prisma.enrollment.create({ data: { userId: user.id, courseId: course.id } });
    enrollmentId = enrollment.id;
    await prisma.workspace.create({
      data: { enrollmentId, status: WorkspaceStatus.RUNNING, labId: `lab_${Date.now()}` },
    });

    accessToken = await signAccessToken({ sub: user.id, email: user.email }, jwtSecret, '15m');
    otherAccessToken = await signAccessToken({ sub: otherUser.id, email: otherUser.email }, jwtSecret, '15m');

    stopVmSpy = jest.spyOn(app.get(LabsClient), 'stopVm').mockResolvedValue(undefined);
    startVmSpy = jest.spyOn(app.get(LabsClient), 'startVm').mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.user.deleteMany({ where: { email: { in: [email, otherEmail] } } });
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(() => {
    stopVmSpy.mockClear();
    startVmSpy.mockClear();
  });

  it('无 token 访问返回 401', async () => {
    await request(app.getHttpServer()).post(`/api/v1/workspaces/${enrollmentId}/stop`).send({ reason: 'manual' }).expect(401);
  });

  it('访问不属于自己的 enrollment 返回 403', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/stop`)
      .set('Authorization', `Bearer ${otherAccessToken}`)
      .send({ reason: 'manual' })
      .expect(403);
  });

  it('手动关闭：真实过一遍 Pipe+Guard 管线，成功停止并写回 STOPPED', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/stop`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ reason: 'manual' })
      .expect(200);

    expect(response.body.status).toBe('STOPPED');
    expect(stopVmSpy).toHaveBeenCalledTimes(1);
  });

  it('幂等：已停止的工作区再次 stop 直接原样返回，不再调用 Labs', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/stop`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ reason: 'manual' })
      .expect(200);

    expect(response.body.status).toBe('STOPPED');
    expect(stopVmSpy).not.toHaveBeenCalled();
  });

  it('恢复：start 成功后状态变回 RUNNING 且 lastSeenAt 被刷新', async () => {
    const before = await prisma.workspace.findUniqueOrThrow({ where: { enrollmentId } });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/start`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.status).toBe('RUNNING');
    expect(startVmSpy).toHaveBeenCalledTimes(1);

    const after = await prisma.workspace.findUniqueOrThrow({ where: { enrollmentId } });
    expect(after.lastSeenAt?.getTime()).toBeGreaterThan(before.lastSeenAt?.getTime() ?? 0);
  });

  it('sendBeacon 场景：没有 Authorization 头，query string 里的 token 也能通过鉴权', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/stop?token=${accessToken}`)
      .send({ reason: 'beacon' })
      .expect(200);

    expect(response.body.status).toBe('STOPPED');
  });

  it('query string 里的 token 无效时返回 401', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/stop?token=not-a-real-token`)
      .send({ reason: 'beacon' })
      .expect(401);
  });

  it('心跳：刷新 lastSeenAt，不需要 body', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/start`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const before = await prisma.workspace.findUniqueOrThrow({ where: { enrollmentId } });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/heartbeat`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.status).toBe('RUNNING');
    const after = await prisma.workspace.findUniqueOrThrow({ where: { enrollmentId } });
    expect(after.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt?.getTime() ?? 0);
  });
});
