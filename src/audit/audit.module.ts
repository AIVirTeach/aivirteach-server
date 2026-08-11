import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// 跟 PrismaModule 一样全局注册：Auth、Admin 以及未来任何模块都要能直接注入，
// 不用每个 feature module 都重复 import 一遍。
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
