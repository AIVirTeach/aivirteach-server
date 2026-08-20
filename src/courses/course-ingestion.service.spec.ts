import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CourseIngestionService } from './course-ingestion.service';

const FIXTURE_DIR = join(__dirname, '__fixtures__', 'sample-course');

const buildPrisma = () => ({
  course: {
    create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'course_1', ...data, versions: [{ id: 'version_1', version: data.versions && (data.versions as any).create.version }] }),
    ),
  },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [CourseIngestionService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(CourseIngestionService);
};

describe('CourseIngestionService.ingestFromDirectory', () => {
  it('读 course.json + 源文件，拼出完整的嵌套 Prisma create', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.ingestFromDirectory(FIXTURE_DIR, 'sha256:test');

    expect(prisma.course.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'sample-course',
          contentId: 'sample-course',
          title: 'Sample Course',
          level: 'BEGINNER',
          tags: ['testing'],
          outcomes: ['Understand the ingestion pipeline.'],
          requirements: ['None.'],
          assets: {
            create: [
              expect.objectContaining({ objectKey: 'cover.png', type: 'image', altText: 'Cover image' }),
            ],
          },
          versions: {
            create: expect.objectContaining({
              version: 1,
              imageDigest: 'sha256:test',
              sourceMarkdown: expect.stringContaining('Section one body.'),
              modules: {
                create: [
                  expect.objectContaining({
                    position: 1,
                    title: 'Module One',
                    lessons: {
                      create: [
                        expect.objectContaining({ position: 1, title: 'Lesson One', assessmentIds: ['check-lesson-1'] }),
                        expect.objectContaining({ position: 2, title: 'Lesson Two', assessmentIds: ['check-lesson-2'] }),
                      ],
                    },
                  }),
                ],
              },
            }),
          },
        }),
      }),
    );
  });

  it('course.json 不存在时抛出可读的错误', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.ingestFromDirectory('/tmp/does-not-exist')).rejects.toThrow();
  });
});
