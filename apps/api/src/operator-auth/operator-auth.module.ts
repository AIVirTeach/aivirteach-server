import { Module } from '@nestjs/common';
import { OperatorAuthController } from './operator-auth.controller';
import { OperatorAuthService } from './operator-auth.service';

@Module({
  controllers: [OperatorAuthController],
  providers: [OperatorAuthService],
  exports: [OperatorAuthService],
})
export class OperatorAuthModule {}
