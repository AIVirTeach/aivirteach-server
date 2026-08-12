import { Injectable } from "@nestjs/common";
import { Activity, ChatMessage, Course, Enrollment, Notification, PracticeSession, User } from "./models";
import { DatabaseRepository } from "./database-repository";
import { seedActivities, seedCourses, seedEnrollments, seedNotifications, seedPracticeSessions, seedUsers } from "./seed";

@Injectable()
export class InMemoryDatabaseService implements DatabaseRepository {
  readonly users = structuredClone(seedUsers);
  readonly courses = structuredClone(seedCourses);
  readonly enrollments = structuredClone(seedEnrollments);
  readonly practiceSessions = structuredClone(seedPracticeSessions);
  readonly notifications = structuredClone(seedNotifications);
  readonly activities = structuredClone(seedActivities);
  readonly chatMessages: ChatMessage[] = [];

  async findUser(id: string) { return this.users.find((user) => user.id === id); }
  async findCourse(id: string) { return this.courses.find((course) => course.id === id); }
  async userEnrollments(userId: string) { return this.enrollments.filter((enrollment) => enrollment.userId === userId); }
  async activeEnrollment(userId: string) { return this.enrollments.find((enrollment) => enrollment.userId === userId && enrollment.active); }
  async userNotifications(userId: string) { return this.notifications.filter((notification) => notification.userId === userId); }
  async userPracticeSessions(userId: string) { return this.practiceSessions.filter((session) => session.userId === userId); }
  async userActivities(userId: string) { return this.activities.filter((activity) => activity.userId === userId); }
  async listUsers() { return this.users; }
  async listCourses() { return this.courses; }
  async saveUser(user: User) { const index = this.users.findIndex((item) => item.id === user.id); if (index >= 0) this.users[index] = user; else this.users.push(user); return user; }
  async createEnrollment(enrollment: Enrollment) { this.enrollments.push(enrollment); return enrollment; }
  async saveEnrollment(enrollment: Enrollment) { const index = this.enrollments.findIndex((item) => item.id === enrollment.id); if (index >= 0) this.enrollments[index] = enrollment; else this.enrollments.push(enrollment); return enrollment; }
  async setActiveEnrollment(userId: string, courseId: string) { for (const enrollment of this.enrollments) if (enrollment.userId === userId) enrollment.active = enrollment.courseId === courseId; return (await this.activeEnrollment(userId))!; }
  async savePracticeSession(session: PracticeSession) { this.practiceSessions.push(session); return session; }
  async saveActivity(activity: Activity) { this.activities.unshift(activity); return activity; }
  async saveNotification(notification: Notification) { this.notifications.push(notification); return notification; }
  async markNotificationRead(userId: string, notificationId: string) { const item = this.notifications.find((notification) => notification.id === notificationId && notification.userId === userId); if (item) item.readAt ??= new Date().toISOString(); return item; }
  async markAllNotificationsRead(userId: string, readAt: string) { let updated = 0; for (const item of this.notifications) if (item.userId === userId && !item.readAt) { item.readAt = readAt; updated += 1; } return updated; }
  async listChatMessages(userId: string, threadId: string) { return this.chatMessages.filter((message) => message.userId === userId && message.threadId === threadId); }
  async saveChatMessages(messages: ChatMessage[]) { this.chatMessages.push(...messages); }

  async resetUser(userId: string): Promise<User | undefined> {
    const userIndex = this.users.findIndex((user) => user.id === userId);
    const seededUser = seedUsers.find((user) => user.id === userId);
    if (userIndex < 0 || !seededUser) return undefined;

    this.users[userIndex] = structuredClone(seededUser);
    this.replaceUserRows(this.enrollments, seedEnrollments, userId);
    this.replaceUserRows(this.practiceSessions, seedPracticeSessions, userId);
    this.replaceUserRows(this.notifications, seedNotifications, userId);
    this.replaceUserRows(this.activities, seedActivities, userId);
    this.replaceUserRows(this.chatMessages, [], userId);
    return this.users[userIndex];
  }

  private replaceUserRows<T extends { userId: string }>(target: T[], seeds: T[], userId: string) {
    for (let index = target.length - 1; index >= 0; index -= 1) {
      if (target[index].userId === userId) target.splice(index, 1);
    }
    target.push(...structuredClone(seeds.filter((item) => item.userId === userId)));
  }
}
