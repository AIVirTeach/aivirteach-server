import { Injectable, NotFoundException } from '@nestjs/common';
import type { CourseAsset } from '@aivirteach/admin-contract';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CourseAssetListService {
  constructor(private readonly prisma: PrismaService) {}

  async list(slug: string): Promise<CourseAsset[]> {
    const course = await this.prisma.course.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!course) throw new NotFoundException(`课程 ${slug} 不存在`);
    const assets = await this.prisma.courseAsset.findMany({
      where: { courseId: course.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        objectKey: true,
        altText: true,
        mimeType: true,
        createdAt: true,
      },
    });
    return assets.map(({ objectKey, createdAt, ...asset }) => ({
      ...asset,
      url: objectKey,
      createdAt: createdAt.toISOString(),
    }));
  }
}
