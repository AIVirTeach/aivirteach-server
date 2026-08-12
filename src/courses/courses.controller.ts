import { Controller, Get, Param, Post, StreamableFile } from "@nestjs/common";
import { createReadStream } from "node:fs";
import { CourseContentService } from "../content/course-content.service";
import { CurrentUserId } from "../common/current-user.decorator";
import { CoursesService } from "./courses.service";

@Controller()
export class CoursesController {
  constructor(private readonly courses: CoursesService, private readonly content: CourseContentService) {}

  @Get("courses")
  list() { return this.courses.list(); }

  @Get("courses/:courseId")
  getById(@Param("courseId") courseId: string) { return this.courses.getById(courseId); }

  @Get("courses/:courseId/lessons/:lessonId")
  getLesson(@Param("courseId") courseId: string, @Param("lessonId") lessonId: string) { return this.courses.getLesson(courseId, lessonId); }

  @Get("courses/:courseId/welcome")
  getWelcome(@Param("courseId") courseId: string) { return this.courses.getWelcome(courseId); }

  @Get("courses/:courseId/assets/:assetId")
  getAsset(@Param("courseId") courseId: string, @Param("assetId") assetId: string) {
    const asset = this.content.getAsset(courseId, assetId);
    return new StreamableFile(createReadStream(asset.path), { type: asset.contentType });
  }

  @Get("me/enrollments")
  listEnrollments(@CurrentUserId() userId: string) { return this.courses.listEnrollments(userId); }

  @Post("courses/:courseId/enroll")
  enroll(@CurrentUserId() userId: string, @Param("courseId") courseId: string) { return this.courses.enroll(userId, courseId); }

  @Post("courses/:courseId/restart")
  restart(@CurrentUserId() userId: string, @Param("courseId") courseId: string) { return this.courses.restart(userId, courseId); }
}
