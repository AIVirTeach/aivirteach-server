import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PrismaService } from '../prisma/prisma.service';
import { CourseAssetStorageService } from './course-asset-storage.service';
import { CourseIngestionService } from './course-ingestion.service';
import { sliceLessonBody } from './lesson-body';

import {
  blocksToPlainText,
  validateLessonContent,
} from '@aivirteach/lesson-blocks';

const FIXTURE_DIR = join(__dirname, '__fixtures__', 'sample-course');
const SOURCE_MARKDOWN = readFileSync(
  join(FIXTURE_DIR, 'lesson-source.md'),
  'utf-8',
);

const buildPrisma = () => ({
  course: {
    create: jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'course_1',
          ...data,
          versions: [
            {
              id: 'version_1',
              version: data.versions && (data.versions as any).create.version,
            },
          ],
        }),
      ),
  },
});

const buildAssetStorage = () => ({
  upload: jest
    .fn()
    .mockImplementation(
      async (pathname: string) => `https://blob.vercel-storage.com/${pathname}`,
    ),
});

const buildService = async (
  prisma: ReturnType<typeof buildPrisma>,
  assetStorage: ReturnType<typeof buildAssetStorage> = buildAssetStorage(),
) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CourseIngestionService,
      { provide: PrismaService, useValue: prisma },
      { provide: CourseAssetStorageService, useValue: assetStorage },
    ],
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
              expect.objectContaining({
                id: expect.any(String),
                objectKey:
                  'https://blob.vercel-storage.com/courses/sample-course/cover.png',
                type: 'image',
                altText: 'Cover image',
              }),
            ],
          },
          versions: {
            create: expect.objectContaining({
              version: 1,
              imageDigest: 'sha256:test',
              sourceMarkdown: SOURCE_MARKDOWN,
              modules: {
                create: [
                  expect.objectContaining({
                    position: 1,
                    title: 'Module One',
                    lessons: {
                      create: [
                        expect.objectContaining({
                          contentId: 'lesson-1',
                          position: 1,
                          title: 'Lesson One',
                          assessmentIds: ['check-lesson-1'],
                          body: sliceLessonBody(SOURCE_MARKDOWN, {
                            startLine: 3,
                            endLine: 4,
                          }),
                          sourceRange: { startLine: 3, endLine: 4 },
                        }),
                        expect.objectContaining({
                          contentId: 'lesson-2',
                          position: 2,
                          title: 'Lesson Two',
                          assessmentIds: ['check-lesson-2'],
                          body: sliceLessonBody(SOURCE_MARKDOWN, {
                            startLine: 5,
                            endLine: 6,
                          }),
                          sourceRange: { startLine: 5, endLine: 6 },
                        }),
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

  it('写入切片 body 与校验通过的转换块，并返回每节转换报告', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    const result = await service.ingestFromDirectory(FIXTURE_DIR);
    const lessons = (prisma.course.create.mock.calls[0][0].data as any).versions
      .create.modules.create[0].lessons.create as any[];

    expect(lessons).toHaveLength(2);
    const persistedAssetIds = (
      prisma.course.create.mock.calls[0][0].data as any
    ).assets.create.map((asset: { id: string }) => asset.id);
    for (const [index, lesson] of lessons.entries()) {
      expect(lesson.body).toBe(
        sliceLessonBody(SOURCE_MARKDOWN, {
          startLine: index ? 5 : 3,
          endLine: index ? 6 : 4,
        }),
      );
      expect(lesson.content.blocks.length).toBeGreaterThan(0);
      expect(
        validateLessonContent(lesson.content, {
          courseAssetIds: new Set(persistedAssetIds),
        }).errors,
      ).toEqual([]);
    }
    expect(result.conversionReports).toHaveLength(2);
    expect(
      result.conversionReports.map(({ lessonContentId }) => lessonContentId),
    ).toEqual(['lesson-1', 'lesson-2']);
    expect(blocksToPlainText(lessons[0].content)).toContain('Welcome.');
  });

  it('按已上传素材 objectKey 的文件名建立转换引用映射', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    const convert = jest
      .spyOn(service as any, 'convertMarkdown')
      .mockImplementation(async (_markdown: string, context: any) => ({
        content: {
          schemaVersion: 1,
          blocks: [
            {
              id: 'b-001',
              type: 'image',
              props: {
                assetId: context.assetIdsByFilename.get('cover.png'),
                alt: 'Cover image',
              },
            },
          ],
        },
        report: [],
        dropped: [],
      }));

    await service.ingestFromDirectory(FIXTURE_DIR);

    const data = prisma.course.create.mock.calls[0][0].data as any;
    const assetId = data.assets.create[0].id;
    const lessonContent =
      data.versions.create.modules.create[0].lessons.create[0].content;
    expect(convert).toHaveBeenCalledWith(expect.any(String), {
      assetIdsByFilename: new Map([['cover.png', assetId]]),
    });
    expect(data.versions.create.introFeaturedAssetIds).toEqual(['cover']);
    expect(lessonContent.blocks[0].props.assetId).toBe(assetId);
    expect(assetId).not.toBe('cover');
  });

  it('相同的课程级源素材 ID 在不同摄取中生成不同数据库 ID', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.ingestFromDirectory(FIXTURE_DIR);
    await service.ingestFromDirectory(FIXTURE_DIR);

    const firstData = prisma.course.create.mock.calls[0][0].data as any;
    const secondData = prisma.course.create.mock.calls[1][0].data as any;
    const firstId = firstData.assets.create[0].id;
    const secondId = secondData.assets.create[0].id;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(secondId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(secondId).not.toBe(firstId);
    expect(firstData.versions.create.introFeaturedAssetIds).toEqual(['cover']);
    expect(secondData.versions.create.introFeaturedAssetIds).toEqual(['cover']);
  });

  it('dry-run and ingestion use the upload filename when source asset id differs from source filename', async () => {
    const contentDir = await mkdtemp(join(tmpdir(), 'lesson-ingestion-'));
    const courseContent = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'course.json'), 'utf8'),
    );
    courseContent.assets[0].id = 'manifest-cover-id';
    courseContent.introduction.featuredAssetIds = ['manifest-cover-id'];
    await writeFile(
      join(contentDir, 'course.json'),
      JSON.stringify(courseContent),
    );
    await writeFile(join(contentDir, 'lesson-source.md'), SOURCE_MARKDOWN);

    try {
      const previewService = await buildService(buildPrisma());
      const previewMaps: Map<string, string>[] = [];
      jest
        .spyOn(previewService as any, 'convertMarkdown')
        .mockImplementation(async (_markdown: string, context: any) => {
          previewMaps.push(context.assetIdsByFilename);
          return {
            content: { schemaVersion: 1, blocks: [] },
            report: [],
            dropped: [],
          };
        });
      await previewService.previewConversions(contentDir);

      const prisma = buildPrisma();
      const assetStorage = buildAssetStorage();
      const ingestionService = await buildService(prisma, assetStorage);
      const ingestionMaps: Map<string, string>[] = [];
      jest
        .spyOn(ingestionService as any, 'convertMarkdown')
        .mockImplementation(async (_markdown: string, context: any) => {
          ingestionMaps.push(context.assetIdsByFilename);
          return {
            content: {
              schemaVersion: 1,
              blocks: [
                {
                  id: 'b-001',
                  type: 'image',
                  props: {
                    assetId: context.assetIdsByFilename.get(
                      'manifest-cover-id.png',
                    ),
                    alt: 'Cover image',
                  },
                },
              ],
            },
            report: [],
            dropped: [],
          };
        });
      await ingestionService.ingestFromDirectory(contentDir);

      const data = prisma.course.create.mock.calls[0][0].data as any;
      const assetId = data.assets.create[0].id;
      const imageAssetId =
        data.versions.create.modules.create[0].lessons.create[0].content
          .blocks[0].props.assetId;
      const expectedFilename = 'manifest-cover-id.png';
      expect(previewMaps[0].has(expectedFilename)).toBe(true);
      expect([...previewMaps[0].keys()]).toEqual([...ingestionMaps[0].keys()]);
      expect(ingestionMaps[0].get(expectedFilename)).toBe(assetId);
      expect(imageAssetId).toBe(assetId);
      expect(data.versions.create.introFeaturedAssetIds).toEqual([
        'manifest-cover-id',
      ]);
      expect(assetStorage.upload).toHaveBeenCalledWith(
        'courses/sample-course/manifest-cover-id.png',
        join(contentDir, 'cover.png'),
      );
    } finally {
      await rm(contentDir, { recursive: true, force: true });
    }
  });

  it('dry-run 只返回转换报告，不上传素材或调用数据库', async () => {
    const prisma = buildPrisma();
    const assetStorage = buildAssetStorage();
    const service = await buildService(prisma, assetStorage);

    const reports = await service.previewConversions(FIXTURE_DIR);

    expect(reports).toHaveLength(2);
    expect(prisma.course.create).not.toHaveBeenCalled();
    expect(assetStorage.upload).not.toHaveBeenCalled();
  });

  it('转换报告含 error 时只将该节 content 设 null，保留 body 并继续摄取', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    jest
      .spyOn(service as any, 'convertMarkdown')
      .mockResolvedValueOnce({
        content: {
          schemaVersion: 1,
          blocks: [{ id: 'b-001', type: 'paragraph', props: { text: 'ok' } }],
        },
        report: [],
        dropped: [],
      })
      .mockResolvedValueOnce({
        content: { schemaVersion: 1, blocks: [] },
        report: [{ level: 'error', code: 'too-large', message: 'too large' }],
        dropped: [],
      });

    const result = await service.ingestFromDirectory(FIXTURE_DIR);
    const lessons = (prisma.course.create.mock.calls[0][0].data as any).versions
      .create.modules.create[0].lessons.create as any[];

    expect(lessons[0].content).not.toBeNull();
    expect(lessons[1].body).toBe(
      sliceLessonBody(SOURCE_MARKDOWN, { startLine: 5, endLine: 6 }),
    );
    expect(lessons[1].content).toBe(Prisma.DbNull);
    expect(result.conversionReports[1]).toEqual({
      lessonContentId: 'lesson-2',
      issues: [{ level: 'error', code: 'too-large', message: 'too large' }],
    });
  });

  it('把每个 asset 的本地文件上传到 Blob 存储，用返回的 URL 作为 objectKey', async () => {
    const prisma = buildPrisma();
    const assetStorage = buildAssetStorage();
    const service = await buildService(prisma, assetStorage);

    await service.ingestFromDirectory(FIXTURE_DIR, 'sha256:test');

    expect(assetStorage.upload).toHaveBeenCalledWith(
      'courses/sample-course/cover.png',
      join(FIXTURE_DIR, 'cover.png'),
    );
  });

  it('course.json 不存在时抛出可读的错误', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.ingestFromDirectory('/tmp/does-not-exist'),
    ).rejects.toThrow();
  });

  it('slug/contentId 冲突（P2002）时转成 ConflictException，不是原始 Prisma 错误', async () => {
    const prisma = buildPrisma();
    prisma.course.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`slug`)',
        {
          code: 'P2002',
          clientVersion: '6.19.3',
        },
      ),
    );
    const service = await buildService(prisma);

    await expect(
      service.ingestFromDirectory(FIXTURE_DIR, 'sha256:test'),
    ).rejects.toThrow(ConflictException);
  });
});
