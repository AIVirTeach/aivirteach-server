import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

const JWT_AUTH_GUARD_STUB = { provide: ENV, useValue: { JWT_SECRET: 'test-secret' } };
const AUTH_REQUEST = { auth: { userId: 'user_1', email: 'learner@example.com' } };

describe('DashboardController', () => {
  it('GET /dashboard 用认证用户的 userId 调用 service.getDashboard', async () => {
    const service = { getDashboard: jest.fn().mockResolvedValue({ learner: {} }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(DashboardController);

    await controller.dashboard(AUTH_REQUEST as any);
    expect(service.getDashboard).toHaveBeenCalledWith('user_1');
  });

  it('POST /practice-sessions 校验 minutes 后调用 service.recordPractice', async () => {
    const service = { recordPractice: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(DashboardController);

    await controller.recordPractice({ minutes: 20 }, AUTH_REQUEST as any);
    expect(service.recordPractice).toHaveBeenCalledWith('user_1', 20);
  });

  it('POST /notifications/read-all 调用 service.markAllNotificationsRead', async () => {
    const service = { markAllNotificationsRead: jest.fn().mockResolvedValue({ updated: 2, readAt: 'now' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(DashboardController);

    await expect(controller.markAllRead(AUTH_REQUEST as any)).resolves.toEqual({ updated: 2, readAt: 'now' });
  });
});
