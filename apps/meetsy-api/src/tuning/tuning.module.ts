import { Module } from "@nestjs/common";
import { AnalysisModule } from "../analysis/analysis.module";
import { KbModule } from "../kb/kb.module";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { TuningController } from "./tuning.controller";
import { MlConfigPreviewService } from "./ml-config-preview.service";

/**
 * v2 Phase 5 — /tuning surface. `KbModule` exports `MlConfigService` +
 * `LearningService`; the resolver is a small stateless service — providing it
 * locally avoids importing `AnalysisModule` (which brings the whole pipeline
 * along transitively). The preview service reads `AnalysisRun` + snapshots via
 * PrismaModule (global).
 */
@Module({
  imports: [KbModule, AnalysisModule],
  controllers: [TuningController],
  providers: [MlConfigPreviewService, WorkspaceResolver],
})
export class TuningModule {}
