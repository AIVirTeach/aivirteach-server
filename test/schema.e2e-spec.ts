import { PrismaClient } from '@prisma/client';

// 需要 docker compose up -d 且已执行 prisma migrate。
describe('数据库 schema', () => {
  const prisma = new PrismaClient();
  const email = `schema-${Date.now()}@example.com`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it('新建用户默认是 INVITED 且没有密码哈希', async () => {
    const user = await prisma.user.create({ data: { email } });

    expect(user.status).toBe('INVITED');
    expect(user.passwordHash).toBeNull();
  });

  it('级联删除会带走用户的邀请记录', async () => {
    const user = await prisma.user.create({
      data: {
        email: `cascade-${Date.now()}@example.com`,
        invitations: {
          create: {
            tokenHash: `hash-${Date.now()}`,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        },
      },
      include: { invitations: true },
    });
    expect(user.invitations).toHaveLength(1);

    await prisma.user.delete({ where: { id: user.id } });

    await expect(
      prisma.invitation.findUnique({ where: { id: user.invitations[0].id } }),
    ).resolves.toBeNull();
  });
});
