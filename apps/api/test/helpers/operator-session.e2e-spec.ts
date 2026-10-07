import { PrismaClient } from '@prisma/client';
import { createOperatorSession } from './operator-session';

describe('createOperatorSession', () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());

  it('同一毫秒、同一个 label 并发创建也不会撞邮箱（并行 worker 下不再偶发失败）', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const sessions = await Promise.all([
        createOperatorSession(prisma, 'race'),
        createOperatorSession(prisma, 'race'),
      ]);
      expect(sessions[0].email).not.toBe(sessions[1].email);
      await Promise.all(sessions.map((s) => s.cleanup()));
    } finally {
      now.mockRestore();
    }
  });
});
