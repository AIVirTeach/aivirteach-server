import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

const JWT_AUTH_GUARD_STUB = { provide: ENV, useValue: { JWT_SECRET: 'test-secret' } };
const AUTH_REQUEST = { auth: { userId: 'user_1', email: 'learner@example.com' } };

describe('WorkspaceController', () => {
  it('GET :enrollmentId 用认证用户的 userId 调用 service.getForEnrollment', async () => {
    const service = { getForEnrollment: jest.fn().mockResolvedValue({ id: 'ws_1' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkspaceController],
      providers: [{ provide: WorkspaceService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(WorkspaceController);

    await expect(controller.get('enr_1', AUTH_REQUEST as any)).resolves.toEqual({ id: 'ws_1' });
    expect(service.getForEnrollment).toHaveBeenCalledWith('user_1', 'enr_1');
  });

  it('POST 用认证用户的 userId 和 body.enrollmentId 调用 service.create', async () => {
    const service = { create: jest.fn().mockResolvedValue({ id: 'ws_1', status: 'CREATING' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkspaceController],
      providers: [{ provide: WorkspaceService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(WorkspaceController);

    await expect(controller.create({ enrollmentId: 'enr_1' }, AUTH_REQUEST as any)).resolves.toEqual({
      id: 'ws_1',
      status: 'CREATING',
    });
    expect(service.create).toHaveBeenCalledWith('user_1', 'enr_1');
  });
});
