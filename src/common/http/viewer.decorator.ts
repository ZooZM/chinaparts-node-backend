import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
  ViewerContext,
  ViewerRequest,
} from './viewer-request';

/**
 * The signed-in caller. Only valid on routes the guard chain guarantees are signed-in
 * (`@Access('signed-in' | 'seller')`), where `req.user` is always set.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

/** The caller on a route that also admits signed-out visitors (`@Access('optional')`). */
export const Viewer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ViewerContext => {
    const request = context.switchToHttp().getRequest<ViewerRequest>();
    return { user: request.user, installationId: request.installationId };
  },
);
