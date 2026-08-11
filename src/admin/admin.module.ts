import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { InviteCommand } from './commands/invite.command';
import {
  CourseCreateCommand,
  CoursePublishCommand,
} from './commands/course.command';
import { EnrollCommand } from './commands/enroll.command';
import { QuotaGrantCommand } from './commands/quota.command';

@Module({
  providers: [
    AdminService,
    InviteCommand,
    CourseCreateCommand,
    CoursePublishCommand,
    EnrollCommand,
    QuotaGrantCommand,
  ],
  exports: [AdminService],
})
export class AdminModule {}
