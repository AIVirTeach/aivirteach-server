import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { CoursesModule } from './courses/courses.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    AdminModule,
    HealthModule,
    CoursesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
