import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService, type TokenPair } from './auth.service';
import {
  AcceptInvitationSchema,
  LoginSchema,
  RefreshSchema,
  type AcceptInvitationInput,
  type LoginInput,
  type RefreshInput,
} from './auth.schemas';
import { JwtAuthGuard, type AuthenticatedRequest } from './jwt-auth.guard';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('invitations/accept')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(AcceptInvitationSchema))
  acceptInvitation(@Body() body: AcceptInvitationInput): Promise<TokenPair> {
    return this.authService.acceptInvitation(body.token, body.password);
  }

  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(LoginSchema))
  login(@Body() body: LoginInput): Promise<TokenPair> {
    return this.authService.login(body.email, body.password);
  }

  @Post('refresh')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(RefreshSchema))
  refresh(@Body() body: RefreshInput): Promise<TokenPair> {
    return this.authService.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @UsePipes(new ZodValidationPipe(RefreshSchema))
  logout(@Body() body: RefreshInput): Promise<void> {
    return this.authService.logout(body.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  me(@Req() request: AuthenticatedRequest): { userId: string; email: string } {
    // Guard 通过后 auth 必然存在。
    return request.auth!;
  }
}
