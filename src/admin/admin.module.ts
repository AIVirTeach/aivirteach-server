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

@Module({
  imports: [CoursesModule],
  providers: [
    AdminService,
    InviteCommand,
    CourseCreateCommand,
    CoursePublishCommand,
    CourseSetCoverCommand,
    EnrollCommand,
    QuotaGrantCommand,
  ],
  exports: [AdminService],
})
export class AdminModule {}
