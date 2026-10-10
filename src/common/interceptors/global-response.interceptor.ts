import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** `{ success, data, message }` (constitution IV). */
export interface StandardResponse<T> {
  success: boolean;
  data: T;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class GlobalResponseInterceptor implements NestInterceptor<
  unknown,
  StandardResponse<unknown>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<StandardResponse<unknown>> {
    return next.handle().pipe(
      map((payload) => {
        // A handler may return `{ data, message }` to control both parts of the envelope;
        // otherwise the whole payload is the data and the message is the default.
        const message =
          isRecord(payload) && typeof payload.message === 'string'
            ? payload.message
            : 'Request successful';
        const data =
          isRecord(payload) && 'data' in payload ? payload.data : payload;

        return { success: true, message, data };
      }),
    );
  }
}
