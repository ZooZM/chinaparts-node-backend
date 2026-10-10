import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errorType = 'InternalServerError';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        // Typical structure from NestJS ValidationPipe errors
        message = (exceptionResponse as any).message || exception.message;
        errorType = (exceptionResponse as any).error || exception.name;
      }
    } else if (exception instanceof Error) {
      // Unhandled errors (e.g. DB disconnects, logic flaws)
      // DO NOT expose exception details directly to the client in Prod.
      message = 'An unexpected error occurred';
      errorType = 'UnexpectedError';
      // In production, log the exact `exception.stack` to a centralized logger here!
      console.error(`[CRITICAL ERROR] ${request.url}`, exception);
    }

    response.status(status).json({
      success: false,
      error: errorType,
      message: message,
      statusCode: status,
    });
  }
}
