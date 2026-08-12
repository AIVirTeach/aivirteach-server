import { Activity, ChatMessage, Course, Enrollment, Notification, PracticeSession, User } from "./models";

export interface DatabaseRepository {
  findUser(id: string): Promise<User | undefined>;
  findCourse(id: string): Promise<Course | undefined>;
  userEnrollments(userId: string): Promise<Enrollment[]>;
  activeEnrollment(userId: string): Promise<Enrollment | undefined>;
  userNotifications(userId: string): Promise<Notification[]>;
  userPracticeSessions(userId: string): Promise<PracticeSession[]>;
  userActivities(userId: string): Promise<Activity[]>;
  listUsers(): Promise<User[]>;
  listCourses(): Promise<Course[]>;
  saveUser(user: User): Promise<User>;
  createEnrollment(enrollment: Enrollment): Promise<Enrollment>;
  saveEnrollment(enrollment: Enrollment): Promise<Enrollment>;
  setActiveEnrollment(userId: string, courseId: string): Promise<Enrollment>;
  savePracticeSession(session: PracticeSession): Promise<PracticeSession>;
  saveActivity(activity: Activity): Promise<Activity>;
  saveNotification(notification: Notification): Promise<Notification>;
  markNotificationRead(userId: string, notificationId: string): Promise<Notification | undefined>;
  markAllNotificationsRead(userId: string, readAt: string): Promise<number>;
  listChatMessages(userId: string, threadId: string): Promise<ChatMessage[]>;
  saveChatMessages(messages: ChatMessage[]): Promise<void>;
  resetUser(userId: string): Promise<User | undefined>;
}
