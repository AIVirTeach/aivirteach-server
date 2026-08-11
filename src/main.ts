import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // client（FrontEnd-v0）把 base URL 写死成 http://localhost:4000/api/v1，
  // 这三行是为了迁就它，不要按 Nest 默认值改回去。
  app.setGlobalPrefix('api/v1');

  // client 跑在 3001，与 server 不同源；不开 CORS 浏览器会直接拦掉所有请求。
  // 用逗号分隔的白名单而不是 origin: true，避免将来部署到公网时变成任意站点可读。
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AIVirTeach Control Plane')
    .setDescription('Closed Beta — Auth / Admin / Health')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
