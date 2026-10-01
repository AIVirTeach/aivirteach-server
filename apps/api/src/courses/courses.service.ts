import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildLessonResponse } from './lesson-response';
import type { LessonResponse } from './lesson-response';
import { LATEST_PUBLISHED_VERSION } from './published-version';
import { loadCourseAssets } from './course-assets';
import { collectImageAssetIds } from '@aivirteach/lesson-blocks';

export type { LessonResponse } from './lesson-response';

const LEVEL_TO_CLIENT: Record<string, string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
};

export type CourseListItem = {
  id: string;
  title: string;
  category: string;
  description: string;
  level: string;
  durationMinutes: number;
  lessonCount: number;
  published: boolean;
  coverAssetId: string | null;
};

export type CourseDetailResponse = CourseListItem & {
  slug: string;
  version: number;
  shortTitle: string | null;
  language: string;
  tags: string[];
  outcomes: string[];
  requirements: string[];
  modules: Array<{
    id: string;
    position: number;
    title: string;
    description: string;
    estimatedMinutes: number;
    lessons: Array<{
      id: string;
      position: number;
      title: string;
      estimatedMinutes: number;
      objectives: string[];
      activity: { type: string; prompt: string; completionType: string };
    }>;
  }>;
};

export type CourseWelcomeResponse = {
  overviewAssetId: string | null;
  overviewHeading: string | null;
  overviewParagraphs: string[];
  howItWorksSteps: unknown;
  finalOutcome: string | null;
};

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async listPublished(): Promise<CourseListItem[]> {
    const courses = await this.prisma.course.findMany({
      where: { published: true },
      orderBy: { createdAt: 'asc' },
    });
    return courses.map((course) => this.toListItem(course));
  }

  async getDetail(slug: string): Promise<CourseDetailResponse> {
    const course = await this.requirePublishedCourseWithLatestVersion(slug);
    const version = course.versions[0];

    return {
      ...this.toListItem(course),
      slug: course.slug,
      version: version.version,
      shortTitle: course.shortTitle,
      language: course.language,
      tags: course.tags,
      outcomes: course.outcomes,
      requirements: course.requirements,
      modules: version.modules.map((courseModule) => ({
        id: courseModule.id,
        position: courseModule.position,
        title: courseModule.title,
        description: courseModule.description,
        estimatedMinutes: courseModule.estimatedMinutes,
        lessons: courseModule.lessons.map((lesson) => ({
          id: lesson.contentId,
          position: lesson.position,
          title: lesson.title,
          estimatedMinutes: lesson.estimatedMinutes,
          objectives: lesson.objectives,
          activity: {
            type: lesson.activityType,
            prompt: lesson.activityPrompt,
            completionType: lesson.activityCompletionType,
          },
        })),
      })),
    };
  }

  async getWelcome(slug: string): Promise<CourseWelcomeResponse> {
    const course = await this.requirePublishedCourseWithLatestVersion(slug);
    const welcome = course.versions[0].welcome;
    if (!welcome) {
      throw new NotFoundException(`课程 ${slug} 还没有欢迎页内容`);
    }
    return {
      overviewAssetId: welcome.overviewAssetId,
      overviewHeading: welcome.overviewHeading,
      overviewParagraphs: welcome.overviewParagraphs,
      howItWorksSteps: welcome.howItWorksSteps,
      finalOutcome: welcome.finalOutcome,
    };
  }

  async getLesson(slug: string, lessonId: string): Promise<LessonResponse> {
    const course = await this.requirePublishedCourseWithLatestVersion(slug);
    const version = course.versions[0];
    const lesson = version.modules
      .flatMap((courseModule) => courseModule.lessons)
      .find((candidate) => candidate.contentId === lessonId);
    const assetIds = collectImageAssetIds(lesson?.content);
    const courseAssets = await loadCourseAssets(
      this.prisma,
      course.id,
      assetIds,
    );
    return buildLessonResponse({
      courseSlug: course.slug,
      modules: version.modules,
      lessonId,
      courseAssets,
    });
  }

  async getAssetUrl(slug: string, assetId: string): Promise<string> {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course || !course.published) {
      throw new NotFoundException(`找不到课程：${slug}`);
    }

    const asset = await this.prisma.courseAsset.findUnique({
      where: { id: assetId },
    });
    if (!asset || asset.courseId !== course.id) {
      throw new NotFoundException(`课程 ${slug} 里找不到资源：${assetId}`);
    }

    return asset.objectKey;
  }

  async requirePublishedCourseWithLatestVersion(slug: string) {
    const course = await this.prisma.course.findUnique({
      where: { slug },
      include: { versions: LATEST_PUBLISHED_VERSION },
    });
    if (!course || !course.published || course.versions.length === 0) {
      throw new NotFoundException(`找不到课程：${slug}`);
    }
    return course;
  }

  private toListItem(course: {
    slug: string;
    title: string;
    category: string;
    description: string;
    level: string;
    durationMinutes: number;
    lessonCount: number;
    published: boolean;
    coverAssetId: string | null;
  }): CourseListItem {
    return {
      id: course.slug,
      title: course.title,
      category: course.category,
      description: course.description,
      level: LEVEL_TO_CLIENT[course.level] ?? course.level,
      durationMinutes: course.durationMinutes,
      lessonCount: course.lessonCount,
      published: course.published,
      coverAssetId: course.coverAssetId,
    };
  }
}
