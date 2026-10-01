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

@Module({
  imports: [CoursesModule],
  providers: [
    AdminService,
    CourseDraftService,
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
