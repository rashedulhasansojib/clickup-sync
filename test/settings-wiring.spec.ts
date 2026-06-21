import { Test } from '@nestjs/testing';
import { HttpModule } from '@nestjs/axios';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { SettingsModule } from '../src/settings/settings.module';
import { SettingsService } from '../src/settings/settings.service';
import { ClickupModule } from '../src/clickup/clickup.module';
import { ClickupClient } from '../src/clickup/clickup.client';
import { ClickupWebhooksService } from '../src/clickup/clickup-webhooks.service';
import { WorkspaceMembersService } from '../src/clickup/workspace-members.service';
import { WorkspaceModule } from '../src/workspaces/workspace.module';
import { WorkspaceService } from '../src/workspaces/workspace.service';

// Validates the actual Nest DI graph (not just `new Service(...)`): the @Global
// SettingsModule (CryptoService) + @Global WorkspaceModule (WorkspaceService)
// must satisfy every ClickUp consumer that now depends on WorkspaceService.
// `.compile()` runs the real constructors; we mock only the DB. Does NOT cover
// AppModule's Redis/Bull/Admin wiring (needs live infra).
describe('Settings DI wiring', () => {
  it('resolves ClickUp consumers that depend on WorkspaceService, and loads the cache on init', async () => {
    const prismaMock = {
      appSettings: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      workspace: { findMany: jest.fn().mockResolvedValue([]) },
      $connect: jest.fn(),
      $disconnect: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, HttpModule, SettingsModule, WorkspaceModule, ClickupModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    // Constructors already ran during compile() — getting them proves the graph.
    expect(moduleRef.get(SettingsService)).toBeDefined();
    expect(moduleRef.get(WorkspaceService)).toBeDefined();
    expect(moduleRef.get(ClickupClient)).toBeDefined();
    expect(moduleRef.get(ClickupWebhooksService)).toBeDefined();
    expect(moduleRef.get(WorkspaceMembersService)).toBeDefined();

    // Exercise the new boot-time DB reads against the mock.
    await moduleRef.get(SettingsService).onModuleInit();
    expect(prismaMock.appSettings.findUnique).toHaveBeenCalled();
    await moduleRef.get(WorkspaceService).onModuleInit();
    expect(prismaMock.workspace.findMany).toHaveBeenCalled();

    await moduleRef.close();
  });
});
