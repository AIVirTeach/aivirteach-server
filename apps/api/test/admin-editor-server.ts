import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AppModule } from '../src/app.module';
import { configureBodyParsers } from '../src/body-parsers';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/auth/password';
import { CourseAssetStorageService } from '../src/courses/course-asset-storage.service';

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (
    database.hostname !== '127.0.0.1' ||
    database.pathname !== '/aivirteach_4b'
  ) {
    throw new Error(
      'Browser harness requires the dedicated local aivirteach_4b database',
    );
  }
  const port = Number(process.env.PORT ?? 4400);
  const files = new Map<string, { body: Buffer; contentType: string }>();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CourseAssetStorageService)
    .useValue({
      uploadBuffer(_pathname: string, body: Buffer, contentType: string) {
        const id = randomUUID();
        files.set(id, { body, contentType });
        return Promise.resolve(`http://127.0.0.1:${port}/test-assets/${id}`);
      },
      delete(url: string) {
        files.delete(url.split('/').at(-1) ?? '');
        return Promise.resolve();
      },
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureBodyParsers(app);
  app.setGlobalPrefix('api/v1');
  app
    .getHttpAdapter()
    .get('/test-assets/:id', (req: Request, res: Response) => {
      const file = files.get(String(req.params.id));
      if (!file) return res.status(404).end();
      return res.type(file.contentType).send(file.body);
    });
  const prisma = app.get(PrismaService);
  await prisma.operator.upsert({
    where: { email: 'editor-e2e@example.com' },
    update: {
      passwordHash: await hashPassword('Local-editor-password-2026'),
      status: 'ACTIVE',
      failedLoginCount: 0,
      lockedUntil: null,
    },
    create: {
      email: 'editor-e2e@example.com',
      passwordHash: await hashPassword('Local-editor-password-2026'),
    },
  });
  await app.listen(port, '127.0.0.1');
  console.log(
    `Admin editor test API ready on ${port}; storage is local test-only memory`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
