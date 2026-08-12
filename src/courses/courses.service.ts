import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseRepository } from "../data/database-repository";
import { CourseContentService } from "../content/course-content.service";

@Injectable()
export class CoursesService {
  constructor(@Inject("DATABASE_REPOSITORY") private readonly db: DatabaseRepository, private readonly content: CourseContentService) {}

  list() { return this.content.listPublishedCourses(); }

  getById(courseId: string) { return this.content.getCourse(courseId); }

  getLesson(courseId: string, lessonId: string) { return this.content.getLesson(courseId, lessonId); }

  getWelcome(courseId: string) { return this.content.getWelcome(courseId); }

  async listEnrollments(userId: string) {
    const enrollments = await this.db.userEnrollments(userId);
    return Promise.all(enrollments.map(async (enrollment) => ({ ...enrollment, course: await this.db.findCourse(enrollment.courseId) })));
  }

  async enroll(userId: string, courseId: string) {
    await this.getById(courseId);
    const storedCourse = await this.db.findCourse(courseId);
    if (!storedCourse) throw new NotFoundException("Course is not available in the learner database");
    const enrollments = await this.db.userEnrollments(userId);
    for (const enrollment of enrollments) enrollment.active = false;

    const existing = enrollments.find((enrollment) => enrollment.userId === userId && enrollment.courseId === courseId);
    if (existing) {
      return { ...(await this.db.setActiveEnrollment(userId, courseId)), course: await this.db.findCourse(courseId) };
    }

    const enrollment = {
      id: `enrollment_${crypto.randomUUID()}`,
      userId,
      courseId,
      active: true,
      progressPercent: 0,
      currentModule: "Module 1: Configure the Runtime Environment",
      enrolledAt: new Date().toISOString(),
    };
    await this.db.createEnrollment(enrollment);
    return { ...enrollment, course: await this.db.findCourse(courseId) };
  }

  async restart(userId: string, courseId: string) {
    await this.getById(courseId);
    const enrollments = await this.db.userEnrollments(userId);
    const existing = enrollments.find((enrollment) => enrollment.courseId === courseId);
    if (!existing) throw new NotFoundException("Course enrollment not found");

    existing.active = false;
    existing.progressPercent = 0;
    existing.currentModule = "Module 1: Configure the Runtime Environment";
    const enrollment = await this.db.saveEnrollment(existing);
    return { ...enrollment, course: await this.db.findCourse(courseId) };
  }
}
