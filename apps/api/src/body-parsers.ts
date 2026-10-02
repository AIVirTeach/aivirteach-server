import type { NestExpressApplication } from '@nestjs/platform-express';

// 课时内容上限是 256 KB（由业务校验并返回 400）；解析器上限必须高于它，
// 否则 express 默认的 100 KB 会先于业务校验返回 413。
export const JSON_BODY_LIMIT = '1mb';

// 调用方需用 { bodyParser: false } 创建应用，这里统一注册。
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: JSON_BODY_LIMIT });
}
