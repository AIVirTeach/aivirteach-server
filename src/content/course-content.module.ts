import { Global, Module } from "@nestjs/common";
import { CourseContentService } from "./course-content.service";

@Global()
@Module({ providers: [CourseContentService], exports: [CourseContentService] })
export class CourseContentModule {}
