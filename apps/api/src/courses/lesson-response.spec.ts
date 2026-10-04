import { NotFoundException } from '@nestjs/common';
import { buildLessonResponse } from './lesson-response';

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
        body: 'body one',
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
        body: 'body two',
        content: null,
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
  it('returns body as markdown and navigation from the flattened module order', () => {
    expect(
      buildLessonResponse({
        courseSlug: 'course',
        modules,
        lessonId: 'lesson-two',
        courseAssets: [],
      }),
    ).toEqual({
      courseId: 'course',
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
      markdown: 'body two',
      blocks: null,
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
                  {
                    id: 'img-foreign',
                    type: 'image',
                    props: { assetId: 'foreign', alt: 'Foreign' },
                  },
                ],
              },
            }
          : lesson,
      ),
    }));
    const result = buildLessonResponse({
      courseSlug: 'course',
      modules: withContent,
      lessonId: 'lesson-one',
      courseAssets,
    });

    expect(result.blocks).toHaveLength(4);
    expect(result.assets).toEqual({
      'asset-a': { url: 'https://cdn.test/a.png', alt: 'A' },
      'asset-b': { url: 'https://cdn.test/b.png' },
    });
    expect(result.markdown).toBe('body one');
  });

  it('returns null blocks and no assets for an invalid content envelope', () => {
    const withInvalidContent = modules.map((courseModule) => ({
      ...courseModule,
      lessons: courseModule.lessons.map((lesson) =>
        lesson.contentId === 'lesson-one'
          ? { ...lesson, content: { schemaVersion: 2, blocks: [] } }
          : lesson,
      ),
    }));
    const result = buildLessonResponse({
      courseSlug: 'course',
      modules: withInvalidContent,
      lessonId: 'lesson-one',
      courseAssets,
    });
    expect(result.blocks).toBeNull();
    expect(result.assets).toEqual({});
  });
});
