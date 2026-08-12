import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Activity, ChatMessage, Course, Enrollment, Notification, PracticeSession, User } from "./models";
import { DatabaseRepository } from "./database-repository";
import { seedActivities, seedCourses, seedEnrollments, seedNotifications, seedPracticeSessions, seedUsers } from "./seed";

type PrismaLike = any;
const iso = (value: Date | string | null | undefined) => value instanceof Date ? value.toISOString() : value;
const enrollmentModel = (row: any): Enrollment | undefined => row ? { ...row, enrolledAt: iso(row.enrolledAt) } : undefined;
const userModel = (row: any): User | undefined => row ? { ...row, joinedAt: iso(row.joinedAt)?.slice(0, 10) } : undefined;
const userData = (user: User) => ({ ...user, joinedAt: new Date(user.joinedAt + (user.joinedAt.includes("T") ? "" : "T00:00:00.000Z")) });

@Injectable()
export class PrismaDatabaseService implements DatabaseRepository, OnModuleDestroy {
  private clientPromise?: Promise<PrismaLike>;

  private async client(): Promise<PrismaLike> {
    if (this.clientPromise) return this.clientPromise;
    const load = new Function("name", "return import(name)") as (name: string) => Promise<any>;
    this.clientPromise = load("@prisma/client").then(({ PrismaClient }) => new PrismaClient());
    return this.clientPromise;
  }

  async onModuleDestroy() { if (this.clientPromise) await (await this.clientPromise).$disconnect(); }

  async findUser(id: string) { const db = await this.client(); return userModel(await db.user.findUnique({ where: { id } })); }
  async findCourse(id: string) { const db = await this.client(); return db.course.findUnique({ where: { id } }) as Promise<Course | undefined>; }
  async userEnrollments(userId: string) { const db = await this.client(); return (await db.enrollment.findMany({ where: { userId } })).map(enrollmentModel); }
  async activeEnrollment(userId: string) { const db = await this.client(); return enrollmentModel(await db.enrollment.findFirst({ where: { userId, active: true } })); }
  async userNotifications(userId: string) { const db = await this.client(); return (await db.notification.findMany({ where: { userId } })).map((row: any) => ({ ...row, createdAt: iso(row.createdAt), readAt: iso(row.readAt) })); }
  async userPracticeSessions(userId: string) { const db = await this.client(); return (await db.practiceSession.findMany({ where: { userId } })).map((row: any) => ({ ...row, startedAt: iso(row.startedAt) })); }
  async userActivities(userId: string) { const db = await this.client(); return (await db.activity.findMany({ where: { userId } })).map((row: any) => ({ ...row, occurredAt: iso(row.occurredAt) })); }
  async listUsers() { const db = await this.client(); return (await db.user.findMany()).map(userModel); }
  async listCourses() { const db = await this.client(); return db.course.findMany() as Promise<Course[]>; }
  async saveUser(user: User) { const db = await this.client(); return userModel(await db.user.upsert({ where: { id: user.id }, create: userData(user), update: userData(user) }))!; }
  async createEnrollment(enrollment: Enrollment) { const db = await this.client(); return db.$transaction(async (tx: PrismaLike) => { await tx.enrollment.updateMany({ where: { userId: enrollment.userId }, data: { active: false } }); return tx.enrollment.upsert({ where: { userId_courseId: { userId: enrollment.userId, courseId: enrollment.courseId } }, create: enrollment, update: { ...enrollment, active: true } }); }) as Promise<Enrollment>; }
  async saveEnrollment(enrollment: Enrollment) { const db = await this.client(); return db.enrollment.update({ where: { id: enrollment.id }, data: enrollment }) as Promise<Enrollment>; }
  async setActiveEnrollment(userId: string, courseId: string) { const db = await this.client(); return db.$transaction(async (tx: PrismaLike) => { await tx.enrollment.updateMany({ where: { userId }, data: { active: false } }); return tx.enrollment.update({ where: { userId_courseId: { userId, courseId } }, data: { active: true } }); }) as Promise<Enrollment>; }
  async savePracticeSession(session: PracticeSession) { const db = await this.client(); return db.practiceSession.create({ data: session }) as Promise<PracticeSession>; }
  async saveActivity(activity: Activity) { const db = await this.client(); return db.activity.create({ data: activity }) as Promise<Activity>; }
  async saveNotification(notification: Notification) { const db = await this.client(); return db.notification.create({ data: notification }) as Promise<Notification>; }
  async markNotificationRead(userId: string, notificationId: string) { const db = await this.client(); return db.notification.updateMany({ where: { id: notificationId, userId, readAt: null }, data: { readAt: new Date() } }).then(async (result: any) => result.count ? db.notification.findUnique({ where: { id: notificationId } }) : undefined) as Promise<Notification | undefined>; }
  async markAllNotificationsRead(userId: string, readAt: string) { const db = await this.client(); const result = await db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date(readAt) } }); return result.count; }
  async listChatMessages(userId: string, threadId: string) { const db = await this.client(); const rows = await db.chatMessage.findMany({ where: { threadId, thread: { userId } }, orderBy: { createdAt: "asc" } }); return rows.map((row: any) => ({ ...row, userId, createdAt: iso(row.createdAt) })); }
  async saveChatMessages(messages: ChatMessage[]) { const db = await this.client(); if (!messages.length) return; const { userId, threadId } = messages[0]; await db.$transaction(async (tx: PrismaLike) => { await tx.chatThread.upsert({ where: { id: threadId }, create: { id: threadId, userId }, update: {} }); await tx.chatMessage.createMany({ data: messages.map(({ userId: _userId, ...message }) => ({ ...message, provider: "mock" })) }); }); }
  async resetUser(userId: string) {
    const db = await this.client();
    const user = seedUsers.find((item) => item.id === userId);
    if (!user) return undefined;
    await db.$transaction(async (tx: PrismaLike) => {
      await tx.chatMessage.deleteMany({ where: { thread: { userId } } });
      await tx.chatThread.deleteMany({ where: { userId } });
      await tx.activity.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.practiceSession.deleteMany({ where: { userId } });
      await tx.enrollment.deleteMany({ where: { userId } });
      await tx.user.upsert({ where: { id: userId }, create: userData(user), update: userData(user) });
      for (const enrollment of seedEnrollments.filter((item) => item.userId === userId)) await tx.enrollment.create({ data: enrollment });
      for (const session of seedPracticeSessions.filter((item) => item.userId === userId)) await tx.practiceSession.create({ data: session });
      for (const notification of seedNotifications.filter((item) => item.userId === userId)) await tx.notification.create({ data: notification });
      for (const activity of seedActivities.filter((item) => item.userId === userId)) await tx.activity.create({ data: activity });
    });
    return user;
  }
}
