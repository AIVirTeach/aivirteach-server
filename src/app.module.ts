import { Module } from "@nestjs/common";
import { CoursesModule } from "./courses/courses.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DataModule } from "./data/data.module";
import { HealthModule } from "./health/health.module";
import { LearningModule } from "./learning/learning.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { UsersModule } from "./users/users.module";
import { ChatModule } from "./chat/chat.module";
import { CourseContentModule } from "./content/course-content.module";
import { LabsModule } from "./labs/labs.module";

@Module({
  imports: [DataModule, CourseContentModule, HealthModule, UsersModule, CoursesModule, LearningModule, NotificationsModule, DashboardModule, ChatModule, LabsModule],
})
export class AppModule {}
