import { NotFoundException } from '@nestjs/common';
import {
  buildLessonResponse,
  InvalidLessonContentError,
} from './lesson-response';

const modules = [
  {
    id: 'module-1',
    courseVersionId: 'version-1',
    position: 1,
    title: 'Module One',
    description: '',
    estimatedMinutes: 20,
    lessons: [
      {
        id: 'internal-1',
        contentId: 'lesson-one',
        moduleId: 'module-1',
        position: 1,
        title: 'Lesson One',
        estimatedMinutes: 10,
        objectives: ['objective'],
        sourceRange: { startLine: 1, endLine: 1 },
        content: null,
        activityType: 'lab',
        activityPrompt: 'prompt',
        activityCompletionType: 'confirmation',
        assessmentIds: [],
      },
      {
        id: 'internal-2',
        contentId: 'lesson-two',
        moduleId: 'module-1',
        position: 2,
        title: 'Lesson Two',
        estimatedMinutes: 10,
        objectives: [],
        sourceRange: null,
        content: { schemaVersion: 1, blocks: [] },
        activityType: 'lab',
        activityPrompt: 'prompt two',
        activityCompletionType: 'confirmation',
        assessmentIds: [],
      },
    ],
  },
];

const courseAssets = [
  { id: 'asset-a', objectKey: 'https://cdn.test/a.png', altText: 'A' },
  { id: 'asset-b', objectKey: 'https://cdn.test/b.png', altText: null },
  { id: 'asset-c', objectKey: 'https://cdn.test/c.png', altText: 'C' },
];

describe('buildLessonResponse', () => {
  it('returns valid blocks and navigation from the flattened module order', () => {
    expect(
      buildLessonResponse({
        courseVersionId: 'version-1',
        courseVersion: 1,
        courseSlug: 'course',
        modules,
        lessonId: 'lesson-two',
        courseAssets: [],
      }),
    ).toEqual({
      courseId: 'course',
      courseVersionId: 'version-1',
      courseVersion: 1,
      module: { id: 'module-1', title: 'Module One', position: 1 },
      lesson: {
        id: 'lesson-two',
        position: 2,
        title: 'Lesson Two',
        estimatedMinutes: 10,
        objectives: [],
        activity: {
          type: 'lab',
          prompt: 'prompt two',
          completionType: 'confirmation',
        },
      },
      blocks: [],
      assets: {},
      assessment: null,
      navigation: {
        previousLessonId: 'lesson-one',
        nextLessonId: null,
        index: 1,
        total: 2,
      },
    });
  });

  it('throws NotFoundException when the contentId is absent', () => {
    expect(() =>
      buildLessonResponse({
        courseVersionId: 'version-1',
        courseVersion: 1,
        courseSlug: 'course',
        modules,
        lessonId: 'missing',
        courseAssets: [],
      }),
    ).toThrow(NotFoundException);
  });

  it('returns validated blocks and only referenced course assets', () => {
    const withContent = modules.map((courseModule) => ({
      ...courseModule,
      lessons: courseModule.lessons.map((lesson) =>
        lesson.contentId === 'lesson-one'
          ? {
              ...lesson,
              content: {
                schemaVersion: 1,
                blocks: [
                  { id: 'p1', type: 'paragraph', props: { text: 'hello' } },
                  {
                    id: 'img-a',
                    type: 'image',
                    props: { assetId: 'asset-a', alt: 'Image A' },
                  },
                  {
                    id: 'img-b',
                    type: 'image',
                    props: { assetId: 'asset-b', alt: 'Image B' },
                  },
                ],
              },
            }
          : lesson,
      ),
    }));
    const result = buildLessonResponse({
      courseVersionId: 'version-1',
      courseVersion: 1,
      courseSlug: 'course',
      modules: withContent,
      lessonId: 'lesson-one',
      courseAssets,
    });

    expect(result.blocks).toHaveLength(3);
    expect(result.assets).toEqual({
      'asset-a': { url: 'https://cdn.test/a.png', alt: 'A' },
      'asset-b': { url: 'https://cdn.test/b.png' },
    });
  });

  it('throws for missing or invalid stored content', () => {
    const withInvalidContent = modules.map((courseModule) => ({
      ...courseModule,
      lessons: courseModule.lessons.map((lesson) =>
        lesson.contentId === 'lesson-one'
          ? { ...lesson, content: { schemaVersion: 2, blocks: [] } }
          : lesson,
      ),
    }));
    expect(() =>
      buildLessonResponse({
        courseVersionId: 'version-1',
        courseVersion: 1,
        courseSlug: 'course',
        modules: withInvalidContent,
        lessonId: 'lesson-one',
        courseAssets,
      }),
    ).toThrow(InvalidLessonContentError);

    expect(() =>
      buildLessonResponse({
        courseVersionId: 'version-1',
        courseVersion: 1,
        courseSlug: 'course',
        modules,
        lessonId: 'lesson-one',
        courseAssets,
      }),
    ).toThrow(InvalidLessonContentError);
  });

  it.each([
    {
      schemaVersion: 1,
      blocks: [{ id: 'bad-props', type: 'paragraph', props: {} }],
    },
    {
      schemaVersion: 1,
      blocks: [
        {
          id: 'missing-asset',
          type: 'image',
          props: { assetId: 'missing', alt: 'x' },
        },
      ],
    },
    {
      schemaVersion: 1,
      blocks: [{ id: 'unknown', type: 'future-widget', props: {} }],
    },
  ])('rejects stored content that fails strict block validation', (content) => {
    const withContent = modules.map((courseModule) => ({
      ...courseModule,
      lessons: courseModule.lessons.map((lesson) =>
        lesson.contentId === 'lesson-one' ? { ...lesson, content } : lesson,
      ),
    }));
    expect(() =>
      buildLessonResponse({
        courseVersionId: 'version-1',
        courseVersion: 1,
        courseSlug: 'course',
        modules: withContent,
        lessonId: 'lesson-one',
        courseAssets,
      }),
    ).toThrow(InvalidLessonContentError);
  });
});
