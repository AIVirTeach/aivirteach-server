import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InMemoryDatabaseService } from "../data/in-memory-database.service";
import { DatabaseRepository } from "../data/database-repository";
import { CourseContentService } from "../content/course-content.service";

@Injectable()
export class LearningService {
  constructor(@Inject("DATABASE_REPOSITORY") private readonly db: DatabaseRepository, private readonly content: CourseContentService) {}

  async recordPractice(userId: string, minutes: number) {
    const user = await this.db.findUser(userId);
    if (!user) throw new NotFoundException("Learner not found");
    const enrollment = await this.db.activeEnrollment(userId);
    const now = new Date().toISOString();
    const session = { id: `practice_${crypto.randomUUID()}`, userId, courseId: enrollment?.courseId ?? null, minutes, startedAt: now };
    await this.db.savePracticeSession(session);
    await this.db.saveActivity({ id: "activity_" + crypto.randomUUID(), userId, title: "Learning workspace session", detail: "Practised for " + minutes + " minutes", kind: "practice", occurredAt: now });
    return session;
  }

  async completeLesson(userId: string, lessonId: string) {
    const user = await this.db.findUser(userId);
    const enrollment = await this.db.activeEnrollment(userId);
    if (!user) throw new NotFoundException("Learner not found");
    if (!enrollment) throw new NotFoundException("No active course enrollment");

    const position = this.content.getLessonPosition(enrollment.courseId, lessonId);
    const nextProgress = Math.round(((position.index + 1) / position.total) * 100);
    enrollment.progressPercent = Math.max(enrollment.progressPercent, nextProgress);
    enrollment.currentModule = position.next
      ? `Module ${position.next.module.position}: ${position.next.module.title}`
      : "All modules and assessments complete";
    user.tasksCompleted += 1;
    await this.db.saveEnrollment(enrollment);
    await this.db.saveUser(user);
    const activity = { id: `activity_${crypto.randomUUID()}`, userId, title: `Lesson ${lessonId} completed`, detail: "Completed in Learning Lab", kind: "lesson" as const, occurredAt: new Date().toISOString() };
    await this.db.saveActivity(activity);
    return { enrollment, activity };
  }

  async submitAssessment(userId: string, courseId: string, lessonId: string, answer: unknown) {
    const enrollment = await this.db.activeEnrollment(userId);
    if (!enrollment || enrollment.courseId !== courseId) throw new NotFoundException("Course is not the learner's active enrollment");
    const result = this.content.gradeAssessment(courseId, lessonId, answer);
    if (!result.correct) return result;
    return { ...result, completion: await this.completeLesson(userId, lessonId) };
  }

  async progress(userId: string) {
    const user = await this.db.findUser(userId);
    if (!user) throw new NotFoundException("Learner not found");
    const sessions = await this.db.userPracticeSessions(userId);
    const totalPracticeMinutes = sessions.reduce((total, session) => total + session.minutes, 0);
    const weeklyMinutes = this.weeklyMinutes(sessions.map(({ startedAt, minutes }) => ({ startedAt, minutes })));
    return { userId, streakDays: user.streakDays, skillsMastered: user.skillsMastered, tasksCompleted: user.tasksCompleted, totalPracticeMinutes, weeklyHours: weeklyMinutes.map((minutes) => Math.round((minutes / 60) * 10) / 10) };
  }

  private weeklyMinutes(sessions: Array<{ startedAt: string; minutes: number }>) {
    const result = Array<number>(7).fill(0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const session of sessions) {
      const sessionDate = new Date(session.startedAt);
      sessionDate.setHours(0, 0, 0, 0);
      const daysAgo = Math.floor((today.getTime() - sessionDate.getTime()) / 86_400_000);
      if (daysAgo >= 0 && daysAgo < 7) result[6 - daysAgo] += session.minutes;
    }
    return result;
  }
}
