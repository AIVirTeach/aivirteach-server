import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

type CatalogCourse = {
  id: string;
  slug: string;
  title: string;
  category: string;
  description: string;
  level: "Beginner" | "Intermediate" | "Advanced";
  durationMinutes: number;
  lessonCount: number;
  published: boolean;
  coverAssetId?: string;
  manifest: string;
};

type CourseAssessment = {
  id: string;
  type: "multiple-choice" | "practical-check" | "ordering" | "capstone-checklist";
  question: string;
  options?: string[];
  criteria?: string[];
  answer: unknown;
  explanation: string;
};

type CourseLesson = {
  id: string;
  position: number;
  title: string;
  estimatedMinutes: number;
  sourceRange: { startLine: number; endLine: number };
  objectives: string[];
  activity: { type: string; prompt: string; completionType: string };
  assessmentIds: string[];
};

type CourseModule = {
  id: string;
  position: number;
  title: string;
  description: string;
  estimatedMinutes: number;
  lessons: CourseLesson[];
};

type CourseManifest = {
  id: string;
  slug: string;
  version: number;
  status: "draft" | "published";
  metadata: Omit<CatalogCourse, "id" | "slug" | "published" | "manifest"> & { shortTitle: string; language: string; tags: string[] };
  outcomes: string[];
  requirements: string[];
  source: { format: "markdown"; path: string; encoding: string };
  assets: Array<{ id: string; type: "image"; path: string; alt: string }>;
  introduction: { sourceRange: { startLine: number; endLine: number }; featuredAssetIds: string[] };
  welcome: { path: string };
  modules: CourseModule[];
  assessments: { path: string; delivery: string };
};

type CourseWelcome = {
  schemaVersion: number;
  courseId: string;
  title: string;
  overviewAssetId: string;
  overview: { heading: string; paragraphs: string[] };
  howItWorks: { heading: string; steps: Array<{ number: string; title: string; description: string }> };
  finalOutcome: { heading: string; description: string };
};

type LoadedCourse = { catalog: CatalogCourse; manifest: CourseManifest; manifestPath: string };

@Injectable()
export class CourseContentService {
  private readonly root = this.findContentRoot();
  private readonly catalog = this.readJson<{ schemaVersion: number; courses: CatalogCourse[] }>(resolve(this.root, "catalog.json"));
  private readonly courseCache = new Map<string, LoadedCourse>();

  listPublishedCourses() {
    return this.catalog.courses.filter((course) => course.published).map(({ manifest: _manifest, slug: _slug, ...course }) => course);
  }

  getCourse(courseId: string) {
    const loaded = this.loadPublishedCourse(courseId);
    const { manifest } = loaded;
    return {
      id: manifest.id,
      slug: manifest.slug,
      version: manifest.version,
      ...manifest.metadata,
      published: true,
      outcomes: manifest.outcomes,
      requirements: manifest.requirements,
      assets: manifest.assets.map(({ id, type, alt }) => ({ id, type, alt })),
      featuredAssetIds: manifest.introduction.featuredAssetIds,
      modules: manifest.modules.map((module) => ({
        id: module.id,
        position: module.position,
        title: module.title,
        description: module.description,
        estimatedMinutes: module.estimatedMinutes,
        lessons: module.lessons.map(({ sourceRange: _sourceRange, assessmentIds: _assessmentIds, ...lesson }) => lesson),
      })),
    };
  }

  getLesson(courseId: string, lessonId: string) {
    const loaded = this.loadPublishedCourse(courseId);
    const found = this.findLesson(loaded.manifest, lessonId);
    const sourcePath = this.resolveInside(this.root, dirname(loaded.manifestPath), loaded.manifest.source.path);
    const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
    const markdown = lines.slice(found.lesson.sourceRange.startLine - 1, found.lesson.sourceRange.endLine).join("\n");
    const assessment = this.loadAssessments(loaded).find((item) => found.lesson.assessmentIds.includes(item.id));

    return {
      courseId,
      module: { id: found.module.id, title: found.module.title, position: found.module.position },
      lesson: {
        id: found.lesson.id,
        position: found.lesson.position,
        title: found.lesson.title,
        estimatedMinutes: found.lesson.estimatedMinutes,
        objectives: found.lesson.objectives,
        activity: found.lesson.activity,
      },
      markdown,
      assessment: assessment ? this.publicAssessment(assessment) : null,
      navigation: this.lessonNavigation(loaded.manifest, lessonId),
    };
  }

  getWelcome(courseId: string) {
    const loaded = this.loadPublishedCourse(courseId);
    const path = this.resolveInside(this.root, dirname(loaded.manifestPath), loaded.manifest.welcome.path);
    const welcome = this.readJson<CourseWelcome>(path);
    if (welcome.courseId !== courseId) throw new InternalServerErrorException("Course welcome data does not match its course");
    const asset = loaded.manifest.assets.find((item) => item.id === welcome.overviewAssetId);
    if (!asset) throw new InternalServerErrorException("Course welcome image is not registered as an asset");
    return { ...welcome, overviewAsset: { id: asset.id, alt: asset.alt } };
  }

  gradeAssessment(courseId: string, lessonId: string, submittedAnswer: unknown) {
    const loaded = this.loadPublishedCourse(courseId);
    const { lesson } = this.findLesson(loaded.manifest, lessonId);
    const assessment = this.loadAssessments(loaded).find((item) => lesson.assessmentIds.includes(item.id));
    if (!assessment) throw new NotFoundException("Lesson assessment not found");
    const correct = JSON.stringify(submittedAnswer) === JSON.stringify(assessment.answer);
    return { correct, explanation: assessment.explanation };
  }

  getLessonPosition(courseId: string, lessonId: string) {
    const manifest = this.loadPublishedCourse(courseId).manifest;
    const lessons = manifest.modules.flatMap((module) => module.lessons.map((lesson) => ({ module, lesson })));
    const index = lessons.findIndex((item) => item.lesson.id === lessonId);
    if (index < 0) throw new NotFoundException("Lesson not found");
    return { index, total: lessons.length, current: lessons[index], next: lessons[index + 1] };
  }

  getAsset(courseId: string, assetId: string) {
    const loaded = this.loadPublishedCourse(courseId);
    const asset = loaded.manifest.assets.find((item) => item.id === assetId);
    if (!asset) throw new NotFoundException("Course asset not found");
    const path = this.resolveInside(this.root, dirname(loaded.manifestPath), asset.path);
    const contentType = extname(path).toLowerCase() === ".png" ? "image/png" : "application/octet-stream";
    return { path, contentType };
  }

  private loadPublishedCourse(courseId: string) {
    const cached = this.courseCache.get(courseId);
    if (cached) return cached;
    const catalog = this.catalog.courses.find((course) => course.id === courseId && course.published);
    if (!catalog) throw new NotFoundException("Course not found");
    const manifestPath = this.resolveInside(this.root, this.root, catalog.manifest);
    const manifest = this.readJson<CourseManifest>(manifestPath);
    if (manifest.id !== catalog.id || manifest.status !== "published") throw new NotFoundException("Course not found");
    const loaded = { catalog, manifest, manifestPath };
    this.courseCache.set(courseId, loaded);
    return loaded;
  }

  private findLesson(manifest: CourseManifest, lessonId: string) {
    for (const module of manifest.modules) {
      const lesson = module.lessons.find((item) => item.id === lessonId);
      if (lesson) return { module, lesson };
    }
    throw new NotFoundException("Lesson not found");
  }

  private lessonNavigation(manifest: CourseManifest, lessonId: string) {
    const lessons = manifest.modules.flatMap((module) => module.lessons);
    const index = lessons.findIndex((lesson) => lesson.id === lessonId);
    if (index < 0) throw new NotFoundException("Lesson not found");
    return { previousLessonId: lessons[index - 1]?.id ?? null, nextLessonId: lessons[index + 1]?.id ?? null, index, total: lessons.length };
  }

  private loadAssessments(loaded: LoadedCourse) {
    const path = this.resolveInside(this.root, dirname(loaded.manifestPath), loaded.manifest.assessments.path);
    return this.readJson<{ assessments: CourseAssessment[] }>(path).assessments;
  }

  private publicAssessment({ answer: _answer, explanation: _explanation, ...assessment }: CourseAssessment) {
    return assessment;
  }

  private findContentRoot() {
    const configured = process.env.COURSE_DATA_PATH;
    const candidates = [
      configured && (isAbsolute(configured) ? configured : resolve(process.cwd(), configured)),
      resolve(process.cwd(), "course data"),
      resolve(process.cwd(), "../course data"),
      resolve(process.cwd(), "../course/course data"),
      resolve(__dirname, "../../../../course data"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const root = candidates.find((candidate) => existsSync(resolve(candidate, "catalog.json")));
    if (!root) throw new InternalServerErrorException("Course data catalog was not found. Set COURSE_DATA_PATH to its directory.");
    return resolve(root);
  }

  private resolveInside(root: string, base: string, input: string) {
    const path = resolve(base, input);
    const relation = relative(root, path);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new BadRequestException("Course content path is outside the course data directory");
    if (!existsSync(path)) throw new InternalServerErrorException(`Course content file is missing: ${input}`);
    return path;
  }

  private readJson<T>(path: string): T {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
      throw new InternalServerErrorException(`Could not read course data from ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  }
}
