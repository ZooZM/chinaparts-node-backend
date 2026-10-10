import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface StandardResponse<T> {
  success: boolean;
  data: T;
  message: string;
}

@Injectable()
export class GlobalResponseInterceptor<T> implements NestInterceptor<
  T,
  StandardResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<StandardResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        // If the service/controller returns an object with a message, use it; else default.
        const returnedMessage =
          typeof data === 'object' && data !== null && 'message' in data
            ? data.message
            : 'Request successful';
        const returnedData =
          typeof data === 'object' && data !== null && 'data' in data
            ? data.data
            : data;

        return {
          success: true,
          message: returnedMessage,
          data: returnedData,
        };
      }),
    );
  }
}
