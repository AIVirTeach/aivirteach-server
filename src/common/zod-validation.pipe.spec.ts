import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({ email: z.email(), password: z.string().min(8) });

describe('ZodValidationPipe', () => {
  it('合法输入原样返回解析结果', () => {
    const pipe = new ZodValidationPipe(schema);

    expect(pipe.transform({ email: 'a@b.com', password: '12345678' })).toEqual({
      email: 'a@b.com',
      password: '12345678',
    });
  });

  it('非法输入抛 BadRequestException 并逐项列出问题字段', () => {
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ email: 'nope', password: 'x' });
      fail('本该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        issues: { path: string; message: string }[];
      };
      expect(response.issues.map((i) => i.path).sort()).toEqual([
        'email',
        'password',
      ]);
    }
  });

  it('剥掉 schema 未声明的多余字段', () => {
    const pipe = new ZodValidationPipe(schema);

    expect(
      pipe.transform({ email: 'a@b.com', password: '12345678', isAdmin: true }),
    ).toEqual({
      email: 'a@b.com',
      password: '12345678',
    });
  });
});
