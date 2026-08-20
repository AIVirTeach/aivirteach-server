import { Module } from '@nestjs/common';
import { CourseIngestionService } from './course-ingestion.service';

@Module({
  providers: [CourseIngestionService],
  exports: [CourseIngestionService],
})
export class CoursesModule {}
