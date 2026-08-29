import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

export type LessonResponse = {
  courseId: string;
  module: { id: string; title: string; position: number };
  lesson: {
    id: string;
    position: number;
    title: string;
    estimatedMinutes: number;
    objectives: string[];
    activity: { type: string; prompt: string; completionType: string };
  };
  markdown: string;
  assessment: null;
  navigation: {
    previousLessonId: string | null;
    nextLessonId: string | null;
    index: number;
    total: number;
  };
};

const COURSE_WITH_LATEST_VERSION_INCLUDE = {
  versions: {
    orderBy: { version: 'desc' as const },
    take: 1,
    include: {
      modules: {
        orderBy: { position: 'asc' as const },
        include: { lessons: { orderBy: { position: 'asc' as const } } },
      },
      welcome: true,
    },
  },
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
    const sourceLines = version.sourceMarkdown?.split('\n') ?? [];

    const flattened = version.modules.flatMap((courseModule) =>
      courseModule.lessons.map((lesson) => ({ courseModule, lesson })),
    );
    const index = flattened.findIndex(
      (entry) => entry.lesson.contentId === lessonId,
    );
    if (index === -1) {
      throw new NotFoundException(`课程 ${slug} 里找不到课时：${lessonId}`);
    }

    const { courseModule, lesson } = flattened[index];
    const range = lesson.sourceRange as { startLine: number; endLine: number };
    const markdown = sourceLines
      .slice(range.startLine - 1, range.endLine)
      .join('\n');

    return {
      courseId: course.slug,
      module: {
        id: courseModule.id,
        title: courseModule.title,
        position: courseModule.position,
      },
      lesson: {
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
      },
      markdown,
      // LessonAssessment 行要等 assessments.json 落地才会存在，这轮之前先固定返回 null。
      assessment: null,
      navigation: {
        previousLessonId: flattened[index - 1]?.lesson.contentId ?? null,
        nextLessonId: flattened[index + 1]?.lesson.contentId ?? null,
        index,
        total: flattened.length,
      },
    };
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
      include: COURSE_WITH_LATEST_VERSION_INCLUDE,
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
