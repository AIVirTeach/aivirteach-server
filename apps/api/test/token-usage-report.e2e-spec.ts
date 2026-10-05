import 'dotenv/config';
import { ConversationRole } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaUsageReadModel } from '../src/token-usage/infrastructure/prisma-usage-read-model';

// 需要 docker compose up -d 且已执行 prisma migrate。
// 夹具放在 2031 年的窗口里，保证按天分组的断言不会混进库里其他测试/真实数据。
describe('PrismaUsageReadModel.report（真实 Postgres）', () => {
  const prisma = new PrismaService();
  const readModel = new PrismaUsageReadModel(prisma);
  const stamp = Date.now();
  const emails = [
    `report-a-${stamp}@example.com`,
    `report-b-${stamp}@example.com`,
    `report-none-${stamp}@example.com`,
  ];
  const slugs = [`report-c1-${stamp}`, `report-c2-${stamp}`];
  const courseIds: string[] = [];
  let userA: string;
  let userB: string;
  let userNone: string;
  const range = {
    from: new Date('2031-03-01T00:00:00Z'),
    to: new Date('2031-03-03T00:00:00Z'),
  };

  beforeAll(async () => {
    userA = (await prisma.user.create({ data: { email: emails[0] } })).id;
    userB = (await prisma.user.create({ data: { email: emails[1] } })).id;
    userNone = (await prisma.user.create({ data: { email: emails[2] } })).id;
    for (const slug of slugs) {
      courseIds.push(
        (
          await prisma.course.create({
            data: { slug, title: slug, published: true },
          })
        ).id,
      );
    }
    const a1 = (
      await prisma.enrollment.create({
        data: { userId: userA, courseId: courseIds[0] },
      })
    ).id;
    const a2 = (
      await prisma.enrollment.create({
        data: { userId: userA, courseId: courseIds[1] },
      })
    ).id;
    const b1 = (
      await prisma.enrollment.create({
        data: { userId: userB, courseId: courseIds[0] },
      })
    ).id;

    const reply = (
      enrollmentId: string,
      at: string,
      tokens: [number, number, number] | null,
      withContext = true,
    ) => ({
      enrollmentId,
      threadId: enrollmentId,
      role: ConversationRole.ASSISTANT,
      content: 'reply',
      createdAt: new Date(at),
      ...(withContext && { contextRef: {} }),
      ...(tokens && {
        inputCacheHitTokens: tokens[0],
        inputCacheMissTokens: tokens[1],
        outputTokens: tokens[2],
      }),
    });
    await prisma.conversation.createMany({
      data: [
        reply(a1, '2031-03-01T10:00:00Z', [1000, 200, 50]),
        reply(a1, '2031-03-01T12:00:00Z', [10, 20, 30]),
        reply(a2, '2031-03-02T09:00:00Z', [100, 0, 5]),
        reply(a1, '2031-03-02T10:00:00Z', null), // 真实 Agent 回复但 Labs 没返回 usage -> unmetered
        reply(a1, '2031-03-02T11:00:00Z', null, false), // 兜底话术（无 contextRef）：既不算 metered 也不算 unmetered
        {
          enrollmentId: a1,
          threadId: a1,
          role: ConversationRole.USER,
          content: 'q',
          createdAt: new Date('2031-03-01T09:00:00Z'),
        },
        reply(b1, '2031-03-01T11:00:00Z', [5, 5, 5]),
        reply(a1, '2031-02-01T10:00:00Z', [999, 999, 999]), // 范围之外
        reply(a1, '2031-03-03T00:00:00Z', [999, 999, 999]), // 上界是开区间，恰在 to 的不算
      ],
    });
    await prisma.quotaLedger.createMany({
      data: [
        { userId: userA, tokensDelta: 1000 },
        { userId: userA, tokensDelta: 500 },
        { userId: userA, minutesDelta: 60 },
        { userId: userB, tokensDelta: 777 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.$disconnect();
  });

  const byKey = <T extends { key: string }>(rows: T[]) =>
    Object.fromEntries(rows.map((r) => [r.key, r]));

  it('groupBy=user：按用户汇总，label 是邮箱，范围外和别人的数据不混入', async () => {
    const rows = byKey(await readModel.report({ ...range, groupBy: 'user' }));

    expect(rows[userA]).toEqual({
      key: userA,
      label: emails[0],
      usage: {
        inputCacheHitTokens: 1110,
        inputCacheMissTokens: 220,
        outputTokens: 85,
      },
      meteredTurns: 3,
      unmeteredTurns: 1,
    });
    expect(rows[userB]).toMatchObject({
      usage: {
        inputCacheHitTokens: 5,
        inputCacheMissTokens: 5,
        outputTokens: 5,
      },
      meteredTurns: 1,
      unmeteredTurns: 0,
    });
    expect(rows[userNone]).toBeUndefined();
  });

  it('groupBy=course：跨用户按课程汇总，label 是 slug', async () => {
    const rows = byKey(await readModel.report({ ...range, groupBy: 'course' }));

    expect(rows[courseIds[0]]).toEqual({
      key: courseIds[0],
      label: slugs[0],
      usage: {
        inputCacheHitTokens: 1015,
        inputCacheMissTokens: 225,
        outputTokens: 85,
      },
      meteredTurns: 3,
      unmeteredTurns: 1,
    });
    expect(rows[courseIds[1]]).toMatchObject({
      usage: {
        inputCacheHitTokens: 100,
        inputCacheMissTokens: 0,
        outputTokens: 5,
      },
      meteredTurns: 1,
      unmeteredTurns: 0,
    });
  });

  it('groupBy=day：按 UTC 日期汇总，按日期升序', async () => {
    const rows = await readModel.report({ ...range, groupBy: 'day' });

    expect(rows).toEqual([
      {
        key: '2031-03-01',
        label: '2031-03-01',
        usage: {
          inputCacheHitTokens: 1015,
          inputCacheMissTokens: 225,
          outputTokens: 85,
        },
        meteredTurns: 3,
        unmeteredTurns: 0,
      },
      {
        key: '2031-03-02',
        label: '2031-03-02',
        usage: {
          inputCacheHitTokens: 100,
          inputCacheMissTokens: 0,
          outputTokens: 5,
        },
        meteredTurns: 1,
        unmeteredTurns: 1,
      },
    ]);
  });

  it('sumGrantedTokensByUser：只算 tokensDelta，没发放过的用户是 0', async () => {
    const granted = await readModel.sumGrantedTokensByUser([
      userA,
      userB,
      userNone,
    ]);

    expect(granted.get(userA)).toBe(1500);
    expect(granted.get(userB)).toBe(777);
    expect(granted.get(userNone)).toBe(0);
  });
});
