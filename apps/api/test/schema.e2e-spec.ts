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

  it('CourseVersion 归属 Course，course 被删时版本一并删除', async () => {
    const course = await prisma.course.create({
      data: {
        slug: `cascade-course-${Date.now()}`,
        title: '级联测试课程',
        versions: { create: { version: 1 } },
      },
      include: { versions: true },
    });

    await prisma.course.delete({ where: { id: course.id } });

    const remaining = await prisma.courseVersion.findUnique({
      where: { id: course.versions[0].id },
    });
    expect(remaining).toBeNull();
  });

  it('QuotaLedger 记录是流水账条目，同一用户可以有多条', async () => {
    const user = await prisma.user.create({
      data: { email: `ledger-${Date.now()}@example.com` },
    });

    await prisma.quotaLedger.create({
      data: { userId: user.id, minutesDelta: 60 },
    });
    await prisma.quotaLedger.create({
      data: { userId: user.id, minutesDelta: 30 },
    });

    const entries = await prisma.quotaLedger.findMany({
      where: { userId: user.id },
    });
    const balance = entries.reduce((sum, entry) => sum + entry.minutesDelta, 0);

    expect(entries).toHaveLength(2);
    expect(balance).toBe(90);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('AuditEvent 可以记录一条没有 actorId 的事件（找不到对应用户时）', async () => {
    const event = await prisma.auditEvent.create({
      data: {
        actorType: 'USER',
        actorId: null,
        action: 'auth.login',
        success: false,
      },
    });

    expect(event.actorId).toBeNull();
    expect(event.reason).toBeNull();
  });
  describe('Operator 表（运营账号）', () => {
    it('有预期的列、类型和默认值', async () => {
      const columns = await prisma.$queryRaw<
        Array<{
          column_name: string;
          is_nullable: string;
          column_default: string | null;
        }>
      >`SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'Operator' ORDER BY column_name`;
      const byName = new Map(columns.map((c) => [c.column_name, c]));

      expect([...byName.keys()].sort()).toEqual(
        [
          'createdAt',
          'email',
          'failedLoginCount',
          'id',
          'lockedUntil',
          'passwordChangedAt',
          'passwordHash',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(byName.get('passwordHash')?.is_nullable).toBe('NO');
      expect(byName.get('lockedUntil')?.is_nullable).toBe('YES');
      expect(byName.get('failedLoginCount')?.column_default).toBe('0');
      expect(byName.get('status')?.column_default).toContain('ACTIVE');
    });

    it('OperatorStatus 只有 ACTIVE 和 DISABLED', async () => {
      const values = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
        SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'OperatorStatus' ORDER BY e.enumsortorder`;
      expect(values.map((v) => v.enumlabel)).toEqual(['ACTIVE', 'DISABLED']);
    });

    it('email 唯一', async () => {
      const indexes = await prisma.$queryRaw<
        Array<{ indexname: string; indexdef: string }>
      >`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Operator'`;
      const unique = indexes.find((i) => i.indexname === 'Operator_email_key');
      expect(unique?.indexdef).toContain('UNIQUE');
    });
  });

  it('AuditEvent 有 createdAt 索引（审计页按时间倒序翻页用）', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'AuditEvent'`;
    expect(indexes.map((i) => i.indexname)).toContain(
      'AuditEvent_createdAt_idx',
    );
  });
});
