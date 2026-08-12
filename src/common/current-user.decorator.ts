import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export const DEFAULT_DEMO_USER_ID = "learner_advanced";

export const CurrentUserId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  const header = request.headers["x-demo-user-id"];
  return (Array.isArray(header) ? header[0] : header) ?? DEFAULT_DEMO_USER_ID;
});
