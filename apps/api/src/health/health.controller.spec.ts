import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  const buildController = async (queryRaw: () => Promise<unknown>) => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();
    return moduleRef.get(HealthController);
  };

  it('数据库可连通时返回 up，且不含 auth/billing 字段', async () => {
    const controller = await buildController(() =>
      Promise.resolve([{ '?column?': 1 }]),
    );

    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });
  });

  it('数据库不可连通时返回 down 而不是抛错', async () => {
    const controller = await buildController(() =>
      Promise.reject(new Error('连不上')),
    );

    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      database: 'down',
    });
  });
});
