import { validateDraftForPublish } from './publish-validation';

const lesson = (contentId: string, position: number, body = 'body') => ({
  contentId,
  position,
  body,
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
  it('collects all validation problems, including lesson, contentId, positions, assets and metadata', () => {
    const input = draft(
      [
        moduleItem(2, [lesson('duplicate', 2, '  ')]),
        moduleItem(2, [lesson('duplicate', 1)]),
      ],
      { level: 'expert' },
    );
    input.welcome = { overviewAssetId: 'foreign-welcome' };

    const problems = validateDraftForPublish({
      draft: input as never,
      courseAssetIds: new Set(['asset-1']),
      coverAssetId: 'foreign-cover',
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('课时内容不能为空'),
        expect.stringContaining('contentId 重复'),
        expect.stringContaining('模块 position 必须连续'),
        expect.stringContaining('课时 position 必须连续'),
        expect.stringContaining('封面资源'),
        expect.stringContaining('欢迎页资源'),
        expect.stringContaining('课程元信息'),
      ]),
    );
  });

  it('requires at least one lesson and does not validate introFeaturedAssetIds', () => {
    const empty = { ...draft([]), introFeaturedAssetIds: ['foreign-intro'] };
    expect(
      validateDraftForPublish({
        draft: empty as never,
        courseAssetIds: new Set(),
        coverAssetId: null,
      }),
    ).toContain('课程至少需要一个课时');

    const valid = {
      ...draft([moduleItem(1, [lesson('lesson-1', 1)])]),
      introFeaturedAssetIds: ['foreign-intro'],
    };
    expect(
      validateDraftForPublish({
        draft: valid as never,
        courseAssetIds: new Set(),
        coverAssetId: null,
      }),
    ).toEqual([]);
  });
});
