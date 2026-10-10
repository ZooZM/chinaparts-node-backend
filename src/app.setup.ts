import {
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { useContainer } from 'class-validator';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ErrorCode } from './common/errors/error-codes';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { GlobalResponseInterceptor } from './common/interceptors/global-response.interceptor';
import { requestSanitizer } from './common/security/sanitize.middleware';

function messagesOf(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...messagesOf(error.children ?? []),
  ]);
}

/**
 * The edge of the application, shared by `main.ts` and the end-to-end tests so a test exercises
 * exactly what production runs: hardening, strict CORS, input sanitization, validation, and the
 * response and error envelopes (constitution IV, V).
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);

  // Lets class-validator constraints inject providers (`@MaxLengthFromConfig` needs ConfigService).
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  // Behind the reverse proxy, `req.ip` must be the client's address, not the proxy's.
  app.set('trust proxy', 1);

  // 1. Attack surface reduction (HTTP headers) and input sanitization.
  app.use(helmet());
  app.use(requestSanitizer());

  // 2. Strict CORS: the mobile apps do not need it, so an empty list means none.
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 3. Global validation: unknown fields are rejected, not silently accepted.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: (errors: ValidationError[]) =>
        new BadRequestException({
          error: ErrorCode.VALIDATION_FAILED,
          message: messagesOf(errors),
        }),
    }),
  );

  // 4. Standard envelopes for success and for errors.
  app.useGlobalInterceptors(new GlobalResponseInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
}
