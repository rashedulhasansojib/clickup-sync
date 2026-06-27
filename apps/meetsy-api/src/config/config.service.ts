import { Injectable } from "@nestjs/common";
import { AppConfig, loadEnv } from "./env";

/**
 * Thin, type-safe accessor over the validated environment.
 * Validation happens once at construction (boot) so invalid config fails fast.
 */
@Injectable()
export class ConfigService {
  private readonly config: AppConfig;

  constructor() {
    this.config = loadEnv();
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  /** Shared ioredis connection options for BullMQ + pub/sub. */
  get redis(): { host: string; port: number } {
    return { host: this.config.REDIS_HOST, port: this.config.REDIS_PORT };
  }

  get all(): AppConfig {
    return this.config;
  }
}
