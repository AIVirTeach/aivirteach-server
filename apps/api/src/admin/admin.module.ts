import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { InviteCommand } from './commands/invite.command';
import {
  CourseCreateCommand,
  CoursePublishCommand,
  CourseSetCoverCommand,
} from './commands/course.command';
import { EnrollCommand } from './commands/enroll.command';
import { QuotaGrantCommand } from './commands/quota.command';
import { CoursesModule } from '../courses/courses.module';
import { ContentModelBackfillService } from './backfill/content-model-backfill.service';
import { CourseBackfillCommand } from './commands/course-backfill.command';
import { CourseDraftService } from './draft/course-draft.service';
import { CoursePublishService } from './course-publish.service';
import { DraftContentService } from './draft/draft-content.service';
import { AdminApiTokenGuard } from './admin-api-token.guard';
import {
  AdminCourseCreateController,
  AdminCoursesController,
} from './admin-courses.controller';
import { CourseCreateService } from './draft/course-create.service';

@Module({
  imports: [CoursesModule],
  controllers: [AdminCoursesController, AdminCourseCreateController],
  providers: [
    AdminService,
    AdminApiTokenGuard,
    CourseDraftService,
    CourseCreateService,
    DraftContentService,
    CoursePublishService,
    InviteCommand,
    CourseCreateCommand,
    CoursePublishCommand,
    CourseSetCoverCommand,
    EnrollCommand,
    QuotaGrantCommand,
    ContentModelBackfillService,
    CourseBackfillCommand,
  ],
  exports: [AdminService],
})
export class AdminModule {}
