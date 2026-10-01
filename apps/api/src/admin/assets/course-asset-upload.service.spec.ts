import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseAssetStorageService } from '../../courses/course-asset-storage.service';
import { CourseAssetUploadService } from './course-asset-upload.service';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('CourseAssetUploadService', () => {
  const prisma = {
    course: { findUnique: jest.fn() },
    courseAsset: { create: jest.fn() },
  };
  const storage = { uploadBuffer: jest.fn() };
  const audit = { record: jest.fn() };
  let service: CourseAssetUploadService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.course.findUnique.mockResolvedValue({ id: 'course-id', slug: 'demo' });
    storage.uploadBuffer.mockResolvedValue('https://blob.test/asset.png');
    prisma.courseAsset.create.mockResolvedValue({ id: 'asset-id' });
    service = new CourseAssetUploadService(
      prisma as unknown as PrismaService,
      storage as unknown as CourseAssetStorageService,
      audit as unknown as AuditService,
    );
  });

  it('stores a sniffed PNG, creates the course asset, and audits exactly once', async () => {
    const result = await service.upload('demo', { buffer: png, size: png.length }, 'Diagram', 'editor');
    expect(storage.uploadBuffer).toHaveBeenCalledWith(
      expect.stringMatching(/^courses\/course-id\/[0-9a-f-]+\.png$/i), png, 'image/png',
    );
    expect(prisma.courseAsset.create).toHaveBeenCalledWith({ data: {
      courseId: 'course-id', type: 'image', objectKey: 'https://blob.test/asset.png',
      altText: 'Diagram', mimeType: 'image/png',
    }, select: { id: true } });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      actor: { type: AuditActorType.OPERATOR, id: 'editor' },
      action: 'admin.course.uploadAsset', success: true, targetType: 'CourseAsset', targetId: 'asset-id',
      metadata: { slug: 'demo', assetId: 'asset-id', mimeType: 'image/png', size: png.length },
    });
    expect(result).toEqual({ id: 'asset-id', url: 'https://blob.test/asset.png', altText: 'Diagram', mimeType: 'image/png' });
  });

  it('rejects spoofed SVG/HTML bytes before storage or database even when caller says PNG', async () => {
    for (const buffer of [Buffer.from('<svg/>'), Buffer.from('<html/>')]) {
      await expect(service.upload('demo', { buffer, size: buffer.length }, undefined, 'editor'))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.course.findUnique).not.toHaveBeenCalled();
    expect(prisma.courseAsset.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects empty and over-limit uploads, while accepting exactly 5 MiB', async () => {
    await expect(service.upload('demo', { buffer: Buffer.alloc(0), size: 0 }, undefined, 'editor'))
      .rejects.toBeInstanceOf(BadRequestException);
    const fiveMiB = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 - png.length)]);
    await expect(service.upload('demo', { buffer: fiveMiB, size: fiveMiB.length }, undefined, 'editor')).resolves.toMatchObject({ id: 'asset-id' });
    await expect(service.upload('demo', { buffer: fiveMiB, size: fiveMiB.length + 1 }, undefined, 'editor'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(storage.uploadBuffer).toHaveBeenCalledTimes(1);
  });

  it('uses a course id path and never a supplied filename', async () => {
    await service.upload('demo', { buffer: png, size: png.length, originalname: 'private-name.png' } as never, undefined, 'editor');
    const path = storage.uploadBuffer.mock.calls[0][0] as string;
    expect(path).toContain('/course-id/');
    expect(path).not.toContain('private-name');
  });

  it('does not create an asset or audit record if storage fails', async () => {
    storage.uploadBuffer.mockRejectedValue(new Error('storage down'));
    await expect(service.upload('demo', { buffer: png, size: png.length }, undefined, 'editor')).rejects.toThrow('storage down');
    expect(prisma.courseAsset.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown course and validates alt text length', async () => {
    prisma.course.findUnique.mockResolvedValue(null);
    await expect(service.upload('missing', { buffer: png, size: png.length }, undefined, 'editor')).rejects.toBeInstanceOf(NotFoundException);
    prisma.course.findUnique.mockResolvedValue({ id: 'course-id', slug: 'demo' });
    await expect(service.upload('demo', { buffer: png, size: png.length }, 'x'.repeat(301), 'editor')).rejects.toBeInstanceOf(BadRequestException);
  });
});
