import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Course, Enrollment, QuotaGrant } from '@prisma/client';
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

  async createCourse(slug: string, title: string): Promise<Course> {
    return this.prisma.course.create({ data: { slug, title } });
  }

  async publishCourse(slug: string): Promise<Course> {
    const course = await this.requireCourse(slug);

    return this.prisma.course.update({
      where: { id: course.id },
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

  async grantQuota(email: string, minutes: number): Promise<QuotaGrant> {
    const user = await this.requireUser(email);

    return this.prisma.quotaGrant.create({
      data: { userId: user.id, minutesGranted: minutes },
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
