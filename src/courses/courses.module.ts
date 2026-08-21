import { Module } from '@nestjs/common';
import { CourseIngestionService } from './course-ingestion.service';
import { CoursesService } from './courses.service';
import { CoursesController } from './courses.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [CoursesController],
  providers: [CourseIngestionService, CoursesService],
  exports: [CourseIngestionService, CoursesService],
})
export class CoursesModule {}
