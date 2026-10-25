import { ContentValidationErrorSchema } from './courses';

describe('content validation failure contract', () => {
  it('preserves the complete report and nested field path', () => {
    const error = {
      message: '课时内容校验未通过，未保存',
      problems: ['Invalid term'],
      validation: {
        errors: [
          {
            code: 'invalid-props',
            message: 'Invalid term',
            level: 'error',
            blockId: 'code',
            blockIndex: 2,
            fieldPath: ['steps', 1, 'terms', 0, 'term'],
          },
        ],
        warnings: [],
      },
    };
    expect(ContentValidationErrorSchema.parse(error)).toEqual(error);
  });

  it('rejects non-addressable field path segments', () => {
    expect(
      ContentValidationErrorSchema.safeParse({
        message: 'Invalid',
        problems: ['Invalid'],
        validation: {
          errors: [
            {
              code: 'invalid-props',
              message: 'Invalid',
              level: 'error',
              fieldPath: [-1],
            },
          ],
          warnings: [],
        },
      }).success,
    ).toBe(false);
  });
});
