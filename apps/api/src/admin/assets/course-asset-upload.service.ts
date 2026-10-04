import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { CourseAssetStorageService } from '../../courses/course-asset-storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { sniffImageMime, type SupportedImageMime } from './image-sniff';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXTENSIONS: Record<SupportedImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

@Injectable()
export class CourseAssetUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseAssetStorageService,
    private readonly audit: AuditService,
  ) {}

  async upload(
    slug: string,
    file: { buffer: Buffer; size: number },
    altText: string | undefined,
    operator: string,
  ): Promise<{
    id: string;
    url: string;
    altText: string | null;
    mimeType: string;
  }> {
    if (
      file.size <= 0 ||
      file.size > MAX_IMAGE_BYTES ||
      file.buffer.length <= 0 ||
      file.buffer.length > MAX_IMAGE_BYTES
    ) {
      throw new BadRequestException('图片大小必须大于 0 且不超过 5 MiB');
    }
    if (altText !== undefined && altText.length > 300) {
      throw new BadRequestException('图片替代文本不能超过 300 个字符');
    }
    const mimeType = sniffImageMime(file.buffer);
    if (!mimeType)
      throw new BadRequestException('仅支持 PNG、JPEG、WebP 或 GIF 图片');

    const course = await this.prisma.course.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!course) throw new NotFoundException(`找不到课程：${slug}`);

    const url = await this.storage.uploadBuffer(
      `courses/${course.id}/${randomUUID()}.${EXTENSIONS[mimeType]}`,
      file.buffer,
      mimeType,
    );
    let asset: { id: string };
    try {
      // 素材行和审计同一事务：审计写失败不会留下没有审计记录的素材。
      asset = await this.prisma.$transaction(async (tx) => {
        const created = await tx.courseAsset.create({
          data: {
            courseId: course.id,
            type: 'image',
            objectKey: url,
            altText: altText ?? null,
            mimeType,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actor: { type: AuditActorType.OPERATOR, id: operator },
            action: 'admin.course.uploadAsset',
            success: true,
            targetType: 'CourseAsset',
            targetId: created.id,
            metadata: { slug, assetId: created.id, mimeType, size: file.size },
          },
          tx,
        );
        return created;
      });
    } catch (error) {
      // 入库失败时别留下无主的 blob；清理失败不能盖掉真正的错误。
      await this.storage.delete(url).catch(() => undefined);
      throw error;
    }
    return { id: asset.id, url, altText: altText ?? null, mimeType };
  }
}
