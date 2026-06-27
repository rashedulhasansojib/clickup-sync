import { Global, Module } from "@nestjs/common";
import { ConfigService } from "./config.service";

/**
 * Global so any module can inject ConfigService without re-importing.
 */
@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
