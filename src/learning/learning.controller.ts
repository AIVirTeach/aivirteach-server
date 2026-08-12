import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { IsDefined, IsInt, Max, Min } from "class-validator";
import { CurrentUserId } from "../common/current-user.decorator";
import { LearningService } from "./learning.service";

class RecordPracticeDto {
  @IsInt() @Min(1) @Max(480) minutes: number;
}

class SubmitAssessmentDto {
  @IsDefined() answer: unknown;
}

@Controller()
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get("progress")
  progress(@CurrentUserId() userId: string) { return this.learning.progress(userId); }

  @Post("practice-sessions")
  recordPractice(@CurrentUserId() userId: string, @Body() input: RecordPracticeDto) { return this.learning.recordPractice(userId, input.minutes); }

  @Post("lessons/:lessonId/complete")
  completeLesson(@CurrentUserId() userId: string, @Param("lessonId") lessonId: string) { return this.learning.completeLesson(userId, lessonId); }

  @Post("courses/:courseId/lessons/:lessonId/assessment")
  submitAssessment(@CurrentUserId() userId: string, @Param("courseId") courseId: string, @Param("lessonId") lessonId: string, @Body() input: SubmitAssessmentDto) {
    return this.learning.submitAssessment(userId, courseId, lessonId, input.answer);
  }
}
