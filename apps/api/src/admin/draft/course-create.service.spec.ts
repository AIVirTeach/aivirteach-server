import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CourseCreateService,
  CreateCourseSchema,
} from './course-create.service';

describe('CreateCourseSchema', () => {
  it.each(['ab', 'A-b', 'a_b', '-ab', 'a'.repeat(61), 'has space'])(
    'rejects invalid slug %s',
    (slug) =>
      expect(() =>
        CreateCourseSchema.parse({ slug, title: 'Title' }),
      ).toThrow(),
  );

  it('accepts valid slug and title bounds', () => {
    expect(
      CreateCourseSchema.parse({ slug: 'intro-to-ai', title: 'A' }),
    ).toEqual({
      slug: 'intro-to-ai',
      title: 'A',
    });
    expect(() =>
      CreateCourseSchema.parse({ slug: 'valid-course', title: '' }),
    ).toThrow();
    expect(() =>
      CreateCourseSchema.parse({
        slug: 'valid-course',
        title: 'x'.repeat(121),
      }),
    ).toThrow();
    expect(() =>
      CreateCourseSchema.parse({
        slug: 'valid-course',
        title: 'Title',
        extra: 1,
      }),
    ).toThrow();
  });
});

describe('CourseCreateService', () => {
  function setup() {
    const tx = {
      course: { create: jest.fn().mockResolvedValue({ id: 'course-1' }) },
      courseVersion: {
        create: jest.fn().mockResolvedValue({ id: 'version-1' }),
      },
    };
    const prisma = {
      course: tx.course,
      courseVersion: tx.courseVersion,
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    return {
      tx,
      prisma,
      audit,
      service: new CourseCreateService(
        prisma as unknown as PrismaService,
        audit as unknown as AuditService,
      ),
    };
  }

  it('creates an unpublished course, v1 draft and empty welcome transactionally then audits', async () => {
    const { tx, prisma, audit, service } = setup();
    let committed = false;
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => {
        const result = await callback(tx);
        committed = true;
        return result;
      },
    );
    audit.record.mockImplementation(async () => {
      expect(committed).toBe(true);
    });

    await expect(
      service.create(
        { slug: 'intro-to-ai', title: 'Intro to AI' },
        'editor@example.com',
      ),
    ).resolves.toMatchObject({ id: 'version-1' });
    expect(tx.course.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'intro-to-ai',
          title: 'Intro to AI',
          published: false,
          contentId: null,
        }),
      }),
    );
    expect(tx.courseVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 1,
          publishedAt: null,
          welcome: { create: {} },
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.course.create',
        targetType: 'Course',
        targetId: 'course-1',
      }),
    );
  });

  it('converts a slug uniqueness violation to 409', async () => {
    const { tx, prisma, service } = setup();
    tx.course.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create(
        { slug: 'intro-to-ai', title: 'Intro' },
        'editor@example.com',
      ),
    ).rejects.toThrow(new ConflictException('slug 已被占用：intro-to-ai'));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not audit if the transaction fails', async () => {
    const { tx, audit, service } = setup();
    tx.course.create.mockRejectedValue(new Error('write failed'));
    await expect(
      service.create(
        { slug: 'intro-to-ai', title: 'Intro' },
        'editor@example.com',
      ),
    ).rejects.toThrow('write failed');
    expect(audit.record).not.toHaveBeenCalled();
  });
});
