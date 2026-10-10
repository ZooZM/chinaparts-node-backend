import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(),
  );
  configureApp(app);
  // Close connections and finish in-flight jobs on SIGTERM, so a deploy never drops work.
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(
    `China Parts reels service listening on port ${port}`,
  );
}

bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
