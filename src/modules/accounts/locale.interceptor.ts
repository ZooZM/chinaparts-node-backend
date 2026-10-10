import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import Redis from 'ioredis';
import type { Observable } from 'rxjs';
import type {
  AuthenticatedRequest,
  Locale,
} from '../../common/http/viewer-request';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AccountsService } from './accounts.service';

/**
 * The first language this service writes in that an `Accept-Language` header asks for, or null.
 * `ar-SA,ar;q=0.9,en;q=0.8` is Arabic; `fr-FR,en;q=0.8` is English; `fr-FR` is neither.
 */
export function localeFromHeader(header: string | undefined): Locale | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? '';
    const language = tag.split('-')[0];
    if (language === 'ar' || language === 'en') return language;
  }
  return null;
}

/**
 * Remembers the language an account last used (FR-065, research R14): China Parts has no
 * per-account language, so a push is written in the language of the account's last request. For a
 * signed-in request it maps `Accept-Language` to `ar` or `en`, and writes only when that differs
 * from what the account already has, so the usual request costs a string comparison. A failure is
 * logged and never touches the request.
 *
 * It runs after the guards, which have already set `request.user` from the account cache.
 */
@Injectable()
export class LocaleInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LocaleInterceptor.name);

  constructor(
    private readonly accounts: AccountsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      const user = request.user;
      const wanted = localeFromHeader(request.headers?.['accept-language']);
      if (user && wanted && wanted !== user.locale) {
        await this.record(user, wanted);
        user.locale = wanted;
      }
    }
    return next.handle();
  }

  private async record(
    user: NonNullable<AuthenticatedRequest['user']>,
    locale: Locale,
  ): Promise<void> {
    try {
      await this.accounts.recordLocale(user.userId, locale);
      // The cached copy is what the next request reads, so it changes too, keeping its expiry.
      const key = `auth:acct:${user.accountType}:${user.externalId}`;
      const cached = await this.redis.get(key);
      if (cached) {
        const entry = JSON.parse(cached) as Record<string, unknown>;
        await this.redis.set(
          key,
          JSON.stringify({ ...entry, locale }),
          'KEEPTTL',
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not record the language of ${user.userId}: ${String(error)}`,
      );
    }
  }
}
