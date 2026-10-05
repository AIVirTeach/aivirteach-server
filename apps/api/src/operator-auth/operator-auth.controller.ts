import { Body, Controller, HttpCode, Post, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  OperatorAuthService,
  type OperatorSession,
} from './operator-auth.service';
import { LoginSchema, type LoginInput } from './operator-auth.schemas';

@ApiTags('Admin Auth')
@Controller('admin/auth')
export class OperatorAuthController {
  constructor(private readonly operatorAuth: OperatorAuthService) {}

  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(LoginSchema))
  login(@Body() body: LoginInput): Promise<OperatorSession> {
    return this.operatorAuth.login(body.email, body.password);
  }
}
