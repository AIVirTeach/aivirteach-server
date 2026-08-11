import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, HealthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
