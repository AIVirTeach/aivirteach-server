import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { OperatorRequest } from './operator-auth.guard';

// 取登录运营的邮箱，作为审计里的 actorId。必须放在 OperatorAuthGuard 之后使用。
export const CurrentOperator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<OperatorRequest>().operator!.email,
);
