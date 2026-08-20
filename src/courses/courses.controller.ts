import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CoursesService,
  type CourseDetailResponse,
  type CourseListItem,
  type CourseWelcomeResponse,
  type LessonResponse,
} from './courses.service';

@ApiTags('Courses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('courses')
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get()
  list(): Promise<CourseListItem[]> {
    return this.coursesService.listPublished();
  }

  @Get(':slug')
  detail(@Param('slug') slug: string): Promise<CourseDetailResponse> {
    return this.coursesService.getDetail(slug);
  }

  @Get(':slug/welcome')
  welcome(@Param('slug') slug: string): Promise<CourseWelcomeResponse> {
    return this.coursesService.getWelcome(slug);
  }

  @Get(':slug/lessons/:lessonId')
  lesson(
    @Param('slug') slug: string,
    @Param('lessonId') lessonId: string,
  ): Promise<LessonResponse> {
    return this.coursesService.getLesson(slug, lessonId);
  }
}
