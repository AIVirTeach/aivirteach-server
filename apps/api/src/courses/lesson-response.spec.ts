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

describe('buildLessonResponse', () => {
  it('returns body as markdown and navigation from the flattened module order', () => {
    expect(
      buildLessonResponse({
        courseSlug: 'course',
        modules,
        lessonId: 'lesson-two',
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
      }),
    ).toThrow(NotFoundException);
  });
});
