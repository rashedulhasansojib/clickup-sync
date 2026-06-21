import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export const SETTINGS_ID = 'singleton';

/** Writable columns of the single app_settings row (app-global prefs only). */
export interface SettingsWrite {
  updatedBy?: string | null;
  preferences?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
}

export interface SettingsRow extends SettingsWrite {
  id: string;
  updatedAt: Date;
}

@Injectable()
export class SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  get(): Promise<SettingsRow | null> {
    return this.prisma.appSettings.findUnique({ where: { id: SETTINGS_ID } }) as Promise<SettingsRow | null>;
  }

  upsert(data: SettingsWrite): Promise<SettingsRow> {
    return this.prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...data },
      update: { ...data },
    }) as Promise<SettingsRow>;
  }
}
