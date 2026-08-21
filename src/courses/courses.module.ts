import { Module } from '@nestjs/common';
import { CourseAssetStorageService } from './course-asset-storage.service';
import { CourseIngestionService } from './course-ingestion.service';
import { CoursesService } from './courses.service';
import { CoursesController } from './courses.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [CoursesController],
  providers: [CourseAssetStorageService, CourseIngestionService, CoursesService],
  exports: [CourseIngestionService, CoursesService],
})
export class CoursesModule {}
