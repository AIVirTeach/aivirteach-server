import { Module } from '@nestjs/common';
import { CourseAssetStorageService } from './course-asset-storage.service';
import { CourseAssetsController } from './course-assets.controller';
import { CourseIngestionService } from './course-ingestion.service';
import { CoursesService } from './courses.service';
import { CoursesController } from './courses.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [CoursesController, CourseAssetsController],
  providers: [
    CourseAssetStorageService,
    CourseIngestionService,
    CoursesService,
  ],
  exports: [CourseAssetStorageService, CourseIngestionService, CoursesService],
})
export class CoursesModule {}
