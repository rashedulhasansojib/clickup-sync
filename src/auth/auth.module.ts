import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from '../admin/admin.module';
import { MailerModule } from './mailer.module';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { PermissionsService } from './permissions.service';
import { SessionService } from './session.service';
import { SessionCleanupService } from './session-cleanup.service';
import { AuthService } from './auth.service';
import { InvitationService } from './invitation.service';
import { UsersService } from './users.service';
import { OrgRepository } from './org.repository';
import { UserRepository } from './user.repository';
import { SessionRepository } from './session.repository';
import { InvitationRepository } from './invitation.repository';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { AuthController } from './auth.controller';
import { InvitationController } from './invitation.controller';
import { UsersController } from './users.controller';
import { isWorker } from '../config/role';

@Module({
  imports: [ConfigModule, MailerModule, AdminModule],
  controllers: [AuthController, InvitationController, UsersController],
  providers: [
    PasswordService, TokenService, PermissionsService, SessionService,
    AuthService, InvitationService, UsersService,
    OrgRepository, UserRepository, SessionRepository, InvitationRepository,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    ...(isWorker() ? [SessionCleanupService] : []),
  ],
  exports: [SessionService, OrgRepository],
})
export class AuthModule {}
