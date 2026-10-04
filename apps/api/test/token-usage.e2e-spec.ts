import 'dotenv/config';
import { ConversationRole } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaUsageReadModel } from '../src/token-usage/infrastructure/prisma-usage-read-model';

// 需要 docker compose up -d 且已执行 prisma migrate。
describe('PrismaUsageReadModel（真实 Postgres）', () => {
  const prisma = new PrismaService();
  const readModel = new PrismaUsageReadModel(prisma);
  const stamp = Date.now();
  const emails = [
    `usage-a-${stamp}@example.com`,
    `usage-b-${stamp}@example.com`,
    `usage-none-${stamp}@example.com`,
  ];
  const courseSlugs = [`usage-c1-${stamp}`, `usage-c2-${stamp}`];
  let userA: string;
  let userB: string;
  let userNone: string;
  const courseIds: string[] = [];

  beforeAll(async () => {
    userA = (await prisma.user.create({ data: { email: emails[0] } })).id;
    userB = (await prisma.user.create({ data: { email: emails[1] } })).id;
    userNone = (await prisma.user.create({ data: { email: emails[2] } })).id;
    for (const slug of courseSlugs) {
      courseIds.push(
        (
          await prisma.course.create({
            data: { slug, title: slug, published: true },
          })
        ).id,
      );
    }
    // userA 在两门课各有一个 enrollment，userB 在第一门课有一个。
    const enrollA1 = await prisma.enrollment.create({
      data: { userId: userA, courseId: courseIds[0] },
    });
    const enrollA2 = await prisma.enrollment.create({
      data: { userId: userA, courseId: courseIds[1] },
    });
    const enrollB = await prisma.enrollment.create({
      data: { userId: userB, courseId: courseIds[0] },
    });

    const turn = (
      enrollmentId: string,
      tokens: [number, number, number] | null,
    ) => ({
      enrollmentId,
      threadId: enrollmentId,
      role: ConversationRole.ASSISTANT,
      content: 'reply',
      ...(tokens && {
        inputCacheHitTokens: tokens[0],
        inputCacheMissTokens: tokens[1],
        outputTokens: tokens[2],
      }),
    });
    await prisma.conversation.createMany({
      data: [
        turn(enrollA1.id, [1000, 200, 50]),
        turn(enrollA1.id, [10, 20, 30]),
        turn(enrollA2.id, [100, 0, 5]),
        turn(enrollA1.id, null), // 兜底话术 / 没有 usage 的回复：按 0 计，不能让求和变 NULL
        {
          enrollmentId: enrollA1.id,
          threadId: enrollA1.id,
          role: ConversationRole.USER,
          content: 'q',
        },
        turn(enrollB.id, [999999, 999999, 999999]), // 别人的用量不能算进 userA
      ],
    });

    await prisma.quotaLedger.createMany({
      data: [
        { userId: userA, tokensDelta: 1000 },
        { userId: userA, tokensDelta: 500 },
        { userId: userA, minutesDelta: 60 }, // 分钟额度不能算进 token 额度
        { userId: userB, tokensDelta: 777 },
      ],
    });
  });

  afterAll(async () => {
    // Course 删除级联 Enrollment -> Conversation；User 删除级联 QuotaLedger。
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.$disconnect();
  });

  it('sumUsage 跨该用户所有 enrollment 求和，忽略空列和别人的数据', async () => {
    await expect(readModel.sumUsage(userA)).resolves.toEqual({
      inputCacheHitTokens: 1110,
      inputCacheMissTokens: 220,
      outputTokens: 85,
    });
  });

  it('没有任何记录的用户 sumUsage 返回全 0', async () => {
    await expect(readModel.sumUsage(userNone)).resolves.toEqual({
      inputCacheHitTokens: 0,
      inputCacheMissTokens: 0,
      outputTokens: 0,
    });
  });

  it('sumGrantedTokens 只累加 tokensDelta，不含分钟额度和别人的发放', async () => {
    await expect(readModel.sumGrantedTokens(userA)).resolves.toBe(1500);
  });

  it('从未发放过额度的用户 sumGrantedTokens 返回 0', async () => {
    await expect(readModel.sumGrantedTokens(userNone)).resolves.toBe(0);
  });

  it('已有的分钟额度行 tokensDelta 默认 0（迁移向后兼容）', async () => {
    const row = await prisma.quotaLedger.findFirstOrThrow({
      where: { userId: userA, minutesDelta: 60 },
    });
    expect(row.tokensDelta).toBe(0);
  });
});
