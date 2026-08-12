import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InMemoryDatabaseService } from "../data/in-memory-database.service";
import { DatabaseRepository } from "../data/database-repository";
import { LearningService } from "../learning/learning.service";

@Injectable()
export class DashboardService {
  constructor(@Inject("DATABASE_REPOSITORY") private readonly db: DatabaseRepository, private readonly learning: LearningService) {}

  async get(userId: string) {
    const user = await this.db.findUser(userId);
    if (!user) throw new NotFoundException("Learner not found");
    const enrollment = await this.db.activeEnrollment(userId);
    const course = enrollment ? await this.db.findCourse(enrollment.courseId) : null;
    const notifications = await this.db.userNotifications(userId);

    return {
      learner: user,
      activeCourse: enrollment && course ? { ...course, enrollment } : null,
      progress: await this.learning.progress(userId),
      unreadNotificationCount: notifications.filter((notification) => notification.readAt === null).length,
      recentActivity: (await this.db.userActivities(userId)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 5),
    };
  }
}
