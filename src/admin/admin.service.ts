import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Course, CourseVersion, Enrollment, QuotaLedger } from '@prisma/client';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InviteResult {
  userId: string;
  email: string;
  invitationToken: string;
  expiresAt: Date;
}

// 封测期所有「开通」动作都走这里。将来 Admin API 接进来时复用同一套规则，
// 不要在 controller 里另写一份。
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async inviteUser(email: string): Promise<InviteResult> {
    const user = await this.prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });

    const invitationToken = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + this.env.INVITATION_TTL_DAYS * DAY_MS,
    );

    await this.prisma.invitation.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(invitationToken),
        expiresAt,
      },
    });

    // 明文只在这里返回一次，之后无法再取回。
    return { userId: user.id, email: user.email, invitationToken, expiresAt };
  }

  async createCourse(
    slug: string,
    title: string,
  ): Promise<Course & { versions: CourseVersion[] }> {
    return this.prisma.course.create({
      data: { slug, title, versions: { create: { version: 1 } } },
      include: { versions: true },
    });
  }

  async publishCourse(slug: string): Promise<CourseVersion> {
    const course = await this.requireCourse(slug);
    const latest = await this.prisma.courseVersion.findFirst({
      where: { courseId: course.id },
      orderBy: { version: 'desc' },
    });
    if (!latest) {
      throw new NotFoundException(`课程 ${slug} 还没有任何版本`);
    }

    // 已经发布过就直接返回，不二次写 publishedAt——发布本身要是幂等操作。
    return latest.publishedAt
      ? latest
      : this.prisma.courseVersion.update({
          where: { id: latest.id },
          data: { publishedAt: new Date() },
        });
  }

  async enrollUser(email: string, courseSlug: string): Promise<Enrollment> {
    const user = await this.requireUser(email);
    const course = await this.requireCourse(courseSlug);

    return this.prisma.enrollment.create({
      data: { userId: user.id, courseId: course.id },
    });
  }

  async grantQuota(email: string, minutes: number): Promise<QuotaLedger> {
    const user = await this.requireUser(email);

    return this.prisma.quotaLedger.create({
      data: { userId: user.id, minutesDelta: minutes },
    });
  }

  private async requireUser(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new NotFoundException(`找不到用户：${email}`);
    }
    return user;
  }

  private async requireCourse(slug: string) {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course) {
      throw new NotFoundException(`找不到课程：${slug}`);
    }
    return course;
  }
}
