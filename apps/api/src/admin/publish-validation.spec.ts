import { validateDraftForPublish } from './publish-validation';
import type { LessonContent } from '@aivirteach/lesson-blocks';

const content = (
  blocks: unknown[] = [
    { id: 'p1', type: 'paragraph', props: { text: 'body' } },
  ],
): LessonContent => ({
  schemaVersion: 1,
  blocks: blocks as LessonContent['blocks'],
});
const lesson = (
  contentId: string,
  position: number,
  lessonContent: unknown = content(),
) => ({
  contentId,
  position,
  title: `课时 ${contentId}`,
  content: lessonContent,
});
const moduleItem = (
  position: number,
  lessons: ReturnType<typeof lesson>[],
) => ({
  position,
  title: `模块 ${position}`,
  lessons,
});
const draft = (
  modules: ReturnType<typeof moduleItem>[],
  meta: unknown = null,
) => ({
  modules,
  meta,
  welcome: null as { overviewAssetId: string | null } | null,
});

describe('validateDraftForPublish', () => {
  it('collects all validation problems, including block, contentId, positions, assets and metadata', () => {
    const input = draft(
      [
        moduleItem(2, [
          lesson(
            'duplicate',
            2,
            content([
              { id: 'unknown', type: 'madeUp', props: {} },
              { id: 'image', type: 'image', props: { assetId: 'foreign' } },
            ]),
          ),
        ]),
        moduleItem(2, [lesson('duplicate', 1)]),
      ],
      { level: 'expert' },
    );
    input.welcome = { overviewAssetId: 'foreign-welcome' };

    const problems = validateDraftForPublish({
      draft: input as never,
      courseAssetIds: new Set(['asset-1']),
      coverAssetId: 'foreign-cover',
      isFirstPublish: true,
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('未知内容块类型'),
        expect.stringContaining('图片资源不存在'),
        expect.stringContaining('没有可渲染内容块'),
        expect.stringContaining('contentId 重复'),
        expect.stringContaining('模块 position 必须连续'),
        expect.stringContaining('课时 position 必须连续'),
        expect.stringContaining('封面资源'),
        expect.stringContaining('欢迎页资源'),
        expect.stringContaining('课程元信息'),
      ]),
    );
  });

  it('requires modules and lessons per module on first publish, but not on later publishes', () => {
    const empty = { ...draft([]), introFeaturedAssetIds: ['foreign-intro'] };
    expect(
      validateDraftForPublish({
        draft: empty as never,
        courseAssetIds: new Set(),
        coverAssetId: null,
        isFirstPublish: true,
      }),
    ).toContain('首次发布的课程至少需要一个模块');
    expect(
      validateDraftForPublish({
        draft: empty as never,
        courseAssetIds: new Set(),
        coverAssetId: null,
        isFirstPublish: false,
      }),
    ).toEqual([]);

    const emptyModule = draft([moduleItem(1, [])]);
    expect(
      validateDraftForPublish({
        draft: emptyModule as never,
        courseAssetIds: new Set(),
        coverAssetId: null,
        isFirstPublish: true,
      }),
    ).toContain('模块「模块 1」至少需要一个课时');

    const valid = {
      ...draft([moduleItem(1, [lesson('lesson-1', 1)])]),
      introFeaturedAssetIds: ['foreign-intro'],
    };
    expect(
      validateDraftForPublish({
        draft: valid as never,
        courseAssetIds: new Set(),
        coverAssetId: null,
        isFirstPublish: true,
      }),
    ).toEqual([]);
  });

  it('ignores warning-only validation reports such as a step gap', () => {
    const step = (id: string, number: number) => ({
      id,
      type: 'step',
      props: { number, title: `Step ${number}`, body: 'body' },
    });
    expect(
      validateDraftForPublish({
        draft: draft([
          moduleItem(1, [
            lesson('lesson-1', 1, content([step('s1', 1), step('s3', 3)])),
          ]),
        ]) as never,
        courseAssetIds: new Set(),
        coverAssetId: null,
        isFirstPublish: true,
      }),
    ).toEqual([]);
  });

  it('reports lessons with null content as having no renderable blocks', () => {
    expect(
      validateDraftForPublish({
        draft: draft([moduleItem(1, [lesson('lesson-1', 1, null)])]) as never,
        courseAssetIds: new Set(),
        coverAssetId: null,
        isFirstPublish: true,
      }),
    ).toContainEqual(expect.stringContaining('没有可渲染内容块'));
  });
});
