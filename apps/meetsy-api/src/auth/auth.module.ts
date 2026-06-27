import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { SessionService } from "./session.service";

/**
 * Cookie-session auth. There is NO Meetsy login — identity comes from Clicksy's
 * `clickup_sync_sid` cookie, validated read-only against public.sessions/users by
 * SessionService. The global AuthGuard/RolesGuard are registered in AppModule.
 * PrismaModule + ConfigModule are global, so SessionService resolves here.
 */
@Module({
  providers: [SessionService],
  controllers: [AuthController],
  exports: [SessionService],
})
export class AuthModule {}
