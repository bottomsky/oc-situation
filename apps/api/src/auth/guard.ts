import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type SessionUser } from './service';
import { assertWriteSecurity, permits } from './security';
import { OPTIONS, type ApiOptions } from '../common';
export interface AuthRequest extends Request {
  user: SessionUser;
  sessionToken: string;
}
export function cookieToken(req: Request) {
  const cookies = (req.headers.cookie ?? '').split(';').map((v) => v.trim());
  const token = cookies.find((v) => v.startsWith('ais_session='))?.slice(12);
  return token;
}
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(OPTIONS) private readonly options: ApiOptions,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = cookieToken(req);
    const session = await this.auth.session(token);
    req.user = session.user;
    req.sessionToken = token!;
    const minimum =
      this.reflector.getAllAndOverride<string>('role', [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'viewer';
    if (!permits(session.user.role, minimum)) throw new ForbiddenException('Insufficient role');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const allowViewerWrite =
        this.reflector.getAllAndOverride<boolean>('allowViewerWrite', [
          context.getHandler(),
          context.getClass(),
        ]) === true;
      if (
        !permits(session.user.role, 'operator') &&
        !allowViewerWrite &&
        req.path !== '/api/v1/auth/logout'
      )
        throw new ForbiddenException('Read only role');
      assertWriteSecurity(req.headers.origin, this.options.origins, req.get('X-CSRF-Token'), token);
    }
    return true;
  }
}
