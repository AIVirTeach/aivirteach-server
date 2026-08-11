import 'dotenv/config';
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

async function bootstrap() {
  // nest-commander 默认的 serviceErrorHandler 只把错误写到 stderr，进程仍然
  // resolve 成功、退出码是 0——运营 CLI 靠退出码判断一次操作是否成功，必须改掉。
  await CommandFactory.run(AppModule, {
    logger: ['warn', 'error'],
    serviceErrorHandler: (err) => {
      process.stderr.write(
        `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = 1;
    },
  });
}
void bootstrap();
