import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { OrgRepository } from './org.repository';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { Public, CurrentUser } from './decorators';
import { SESSION_COOKIE } from './auth.guard';
import { AuthPrincipal } from './auth.types';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly orgs: OrgRepository,
  ) {}

  private async setSession(res: Response, req: Request, userId: string) {
    const { token } = await this.sessions.issue(userId, req.ip ?? null, (req.headers['user-agent'] as string) ?? null);
    const csrf = randomBytes(16).toString('hex');
    const secure = process.env.NODE_ENV === 'production';
    const maxAge = this.sessions.cookieMaxAgeMs();
    // COOKIE_DOMAIN (e.g. ".example.com") scopes the session + csrf cookies to the
    // parent domain so they're also sent to sibling apps (Meetsy at
    // meetsy.<domain>). Unset locally (localhost is subdomain-less) → undefined,
    // which leaves the cookie host-only exactly as before.
    const domain = process.env.COOKIE_DOMAIN || undefined;
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge, domain });
    res.cookie('csrf', csrf, { httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge, domain });
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.signup(dto);
    await this.setSession(res, req, user.id);
    const org = await this.orgs.get();
    return { user: this.publicUser(user), org: { id: org?.id, name: org?.name } };
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.login(dto);
    await this.setSession(res, req, user.id);
    const org = await this.orgs.get();
    return { user: this.publicUser(user), org: { id: org?.id, name: org?.name } };
  }

  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await this.sessions.revoke(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie('csrf', { path: '/' });
    return { ok: true };
  }

  @HttpCode(200)
  @Post('logout-all')
  async logoutAll(@CurrentUser() user: AuthPrincipal, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revokeAll(user.userId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie('csrf', { path: '/' });
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthPrincipal) {
    if (!user) throw new UnauthorizedException();
    const org = await this.orgs.get(user.orgId);
    return { user: { id: user.userId, email: user.email, role: user.role, isMachine: user.isMachine }, org: { id: org?.id, name: org?.name } };
  }

  private publicUser(u: { id: string; email: string; name: string | null; role: string }) {
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  }
}
