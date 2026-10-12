import { Body, Controller, Get, Post, Req, Res, Inject, HttpCode } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from './service';
import { assertWriteSecurity } from './security';
import type { AuthRequest } from './guard';
import { DocumentRoute, Public, OPTIONS, type ApiOptions, parse } from '../common';
import { LoginSchema, SessionResponseSchema } from './schemas';
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OPTIONS) private readonly options: ApiOptions,
  ) {}
  @Public()
  @Post('login')
  @HttpCode(200)
  @DocumentRoute(
    'Create an eight hour session; Origin required',
    SessionResponseSchema,
    LoginSchema,
  )
  async login(
    @Body() body: unknown,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertWriteSecurity(req.headers.origin, this.options.origins);
    const input = parse(LoginSchema, body);
    const result = await this.auth.login(input.username, input.password, req.ip ?? 'unknown');
    res.cookie('ais_session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.options.production,
      maxAge: 8 * 60 * 60 * 1000,
      path: '/api/v1',
    });
    const { token: _token, ...session } = result;
    return session;
  }
  @Get('me')
  @DocumentRoute('Read current session and CSRF token', SessionResponseSchema)
  me(@Req() req: AuthRequest) {
    return this.auth.session(req.sessionToken);
  }
  @Post('logout')
  @HttpCode(204)
  @DocumentRoute('Revoke current session', z.null(), undefined, 204)
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.sessionToken);
    res.clearCookie('ais_session', {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.options.production,
      path: '/api/v1',
    });
  }
}
