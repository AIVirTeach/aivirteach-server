import { seedActivities, seedCourses, seedEnrollments, seedNotifications, seedPracticeSessions, seedUsers } from "../src/data/seed";

async function main() {
  const load = new Function("name", "return import(name)") as (name: string) => Promise<any>;
  const { PrismaClient } = await load("@prisma/client");
  const prisma = new PrismaClient();
  for (const user of seedUsers) {
    const data = { ...user, joinedAt: new Date(user.joinedAt + "T00:00:00.000Z") };
    await prisma.user.upsert({ where: { id: user.id }, create: data, update: data });
  }
  for (const course of seedCourses) await prisma.course.upsert({ where: { id: course.id }, create: { ...course, level: course.level }, update: { ...course, level: course.level } });
  for (const enrollment of seedEnrollments) {
    await prisma.enrollment.updateMany({
      where: { userId: enrollment.userId, active: true, id: { not: enrollment.id } },
      data: { active: false },
    });
    await prisma.enrollment.upsert({ where: { id: enrollment.id }, create: enrollment, update: enrollment });
  }
  for (const session of seedPracticeSessions) await prisma.practiceSession.upsert({ where: { id: session.id }, create: session, update: session });
  for (const notification of seedNotifications) await prisma.notification.upsert({ where: { id: notification.id }, create: notification, update: notification });
  for (const activity of seedActivities) await prisma.activity.upsert({ where: { id: activity.id }, create: activity, update: activity });
  await prisma.$disconnect();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
