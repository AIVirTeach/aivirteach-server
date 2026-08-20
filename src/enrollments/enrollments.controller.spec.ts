import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';

const JWT_AUTH_GUARD_STUB = { provide: ENV, useValue: { JWT_SECRET: 'test-secret' } };
const AUTH_REQUEST = { auth: { userId: 'user_1', email: 'learner@example.com' } };

describe('EnrollmentsController', () => {
  it('POST /courses/:slug/enroll 用认证用户的 userId 调用 service.enroll', async () => {
    const service = { enroll: jest.fn().mockResolvedValue({ id: 'enrollment_1' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [{ provide: EnrollmentsService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(EnrollmentsController);

    await expect(controller.enroll('sample', AUTH_REQUEST as any)).resolves.toEqual({ id: 'enrollment_1' });
    expect(service.enroll).toHaveBeenCalledWith('user_1', 'sample');
  });

  it('POST /courses/:slug/restart 用认证用户的 userId 调用 service.restart', async () => {
    const service = { restart: jest.fn().mockResolvedValue({ id: 'enrollment_1' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [{ provide: EnrollmentsService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(EnrollmentsController);

    await expect(controller.restart('sample', AUTH_REQUEST as any)).resolves.toEqual({ id: 'enrollment_1' });
    expect(service.restart).toHaveBeenCalledWith('user_1', 'sample');
  });

  it('GET /me/enrollments 用认证用户的 userId 调用 service.listForUser', async () => {
    const service = { listForUser: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [{ provide: EnrollmentsService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(EnrollmentsController);

    await expect(controller.myEnrollments(AUTH_REQUEST as any)).resolves.toEqual([]);
    expect(service.listForUser).toHaveBeenCalledWith('user_1');
  });

  it('POST /lessons/:lessonId/complete 用认证用户的 userId 调用 service.completeLesson', async () => {
    const service = { completeLesson: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [{ provide: EnrollmentsService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(EnrollmentsController);

    await controller.completeLesson('lesson_1', AUTH_REQUEST as any);
    expect(service.completeLesson).toHaveBeenCalledWith('user_1', 'lesson_1');
  });
});
