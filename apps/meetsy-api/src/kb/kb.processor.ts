import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Job, Worker } from "bullmq";
import { Prisma } from "@prisma/client";
import { ConfigService } from "../config/config.service";
import { PrismaService } from "../prisma/prisma.service";
import { AzureEmbeddingService } from "../azure/azure-embedding.service";
import { buildTaskCard, type CommentCardInput, type TaskCard, type TaskCardInput } from "./card-builder";
import { KbOnboardingService } from "./kb-onboarding.service";
import { KB_QUEUE_NAME, KbJobData, KbQueue } from "./kb.queue";
import { windowStart, type KbScope } from "./kb.dto";

const EMBED_DIMS = 1024;
const EMBED_VERSION = 1;
/** Tasks scanned per page (checkpoint granularity). */
const SCAN_PAGE = 100;
/** Max inputs per embedding API call (Azure batch budget). */
const EMBED_BATCH = 256;

/**
 * Build a Prisma `ClickupTask` WHERE fragment from the run's scope filter. Each
 * axis contributes an `{ in: [...] }` ONLY when its array is non-empty; present
 * axes AND together. An absent/empty scope yields `{}` (no sub-filter) so it's
 * spread-safe into the existing query. Spread into BOTH the progress denominator
 * count and the page scan so SSE `total`/progress reflect the scoped run.
 */
export function buildScopeWhere(scope?: KbScope): Prisma.ClickupTaskWhereInput {
  const where: Prisma.ClickupTaskWhereInput = {};
  if (scope?.spaceIds?.length) where.spaceId = { in: scope.spaceIds };
  if (scope?.folderNames?.length) where.folderName = { in: scope.folderNames };
  if (scope?.listIds?.length) where.listId = { in: scope.listIds };
  if (scope?.clients?.length) where.client = { in: scope.clients };
  return where;
}

/** A pgvector literal: `[0.1,0.2,...]` (bound as text, cast to ::vector in SQL). */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/** Split into fixed-size chunks (pure helper). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Embed cards in batches (≤256/call), preserving input→vector alignment.
 * Exported + dependency-light so it can be unit-tested with a mocked embedder.
 */
export async function embedInBatches(
  embedder: { embed: (input: string[], opts: { dimensions: number }) => Promise<number[][]> },
  cards: Array<{ sourceId: string; content: string }>,
  batchSize: number = EMBED_BATCH,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (const batch of chunk(cards, batchSize)) {
    const vectors = await embedder.embed(batch.map((c) => c.content), { dimensions: EMBED_DIMS });
    batch.forEach((c, i) => out.set(c.sourceId, vectors[i]));
  }
  return out;
}

/**
 * The `meetsy-kb` BullMQ worker (runs in-process, mirrors AnalysisProcessor).
 *
 * Per job: ensure ClickUp history is mirrored (coverage check → optional Clicksy
 * backfill), then incrementally embed the workspace's tasks into `kb_chunk`:
 * scan tasks past the cursor, skip unchanged (content-hash), embed the rest
 * (batched), upsert the vector via raw SQL, and advance the cursor TRANSACTIONALLY
 * with the upserts so a crash can't skip un-embedded rows.
 */
@Injectable()
export class KbProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbProcessor.name);
  private worker!: Worker<KbJobData>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly azure: AzureEmbeddingService,
    private readonly onboarding: KbOnboardingService,
    private readonly queue: KbQueue,
  ) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.worker = new Worker<KbJobData>(
      KB_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: { host, port, maxRetriesPerRequest: null },
        // A healthy long run (embed + bounded Clicksy poll) keeps its lock via
        // BullMQ's auto-renewal (every lockDuration/2), which runs on a timer
        // independent of the awaited I/O. lockDuration only governs how long
        // after a CRASH the job is reclaimed — keep it short so a killed worker
        // recovers in ~2-3min, not 10. 120s is low enough for fast recovery yet
        // high enough to avoid false-stalls when this box is under load.
        lockDuration: 120_000,
        stalledInterval: 30_000,
        // One automatic re-run after a crash; a second stall = terminal failure
        // (handled below), so a poison job can't loop forever.
        maxStalledCount: 1,
      },
    );
    // Authoritative terminal handler. A job that exceeds maxStalledCount is moved
    // straight to `failed` by BullMQ WITHOUT re-entering process(), so the catch
    // in process() never runs — without this, kbSyncState would stay stuck on
    // "onboarding" forever and the status SSE would never complete. Idempotent
    // with the catch block (both set "error"); the `stalled` event (first stall,
    // re-queued) deliberately does NOT touch state.
    this.worker.on("failed", (job, err) => {
      this.logger.error(`KB job ${job?.id} failed: ${err.message}`);
      void this.markFailed(job?.data?.workspaceId, err.message);
    });
    this.worker.on("stalled", (jobId) => {
      this.logger.warn(`KB job ${jobId} stalled; BullMQ will re-queue it`);
    });
    this.logger.log(`KB worker listening on "${KB_QUEUE_NAME}"`);
  }

  private async process(job: Job<KbJobData>): Promise<void> {
    const { workspaceId, range, scope } = job.data;
    try {
      // 1) Make sure the requested window is mirrored (degrades if Clicksy down).
      await this.onboarding.ensureCoverage(workspaceId, range, scope);
      // 2) Incrementally embed.
      const embedded = await this.embedWorkspace(workspaceId, range, scope);
      // 3) Mark ready with the true chunk count.
      const total = await this.prisma.kbChunk.count({
        where: { workspaceId, sourceType: "clickup_task" },
      });
      await this.prisma.kbSyncState.update({
        where: { workspaceId },
        data: { status: "ready", embeddedCount: total, lastRunAt: new Date() },
      });
      await this.emit(workspaceId, "ready", total, total, `Onboarding complete (${embedded} embedded)`);
    } catch (err) {
      const message = (err as Error).message ?? "Unknown error";
      this.logger.error(`KB onboarding for ${workspaceId} failed: ${message}`);
      await this.prisma.kbSyncState
        .update({ where: { workspaceId }, data: { status: "error" } })
        .catch(() => undefined);
      await this.emit(workspaceId, "error", 0, 0, message);
      throw err;
    }
  }

  /**
   * Scan tasks past the cursor in pages, embed changed/new cards, upsert, and
   * advance the cursor transactionally. Returns the number of chunks (re)embedded.
   */
  private async embedWorkspace(
    workspaceId: string,
    range: KbJobData["range"],
    scope?: KbScope,
  ): Promise<number> {
    const state = await this.prisma.kbSyncState.findUnique({ where: { workspaceId } });
    // First run: scan the whole requested window; otherwise continue past cursor.
    let cursor = state?.lastTaskCursor ?? windowStart(range);

    // Scope sub-filter ANDed into BOTH the denominator count and the page scan, so
    // SSE total/progress reflect only the scoped run.
    const scopeWhere = buildScopeWhere(scope);

    const total = await this.prisma.clickupTask.count({
      where: { workspaceId, isDeleted: false, updatedDate: { gt: cursor }, ...scopeWhere },
    });
    const model = this.config.get("AZURE_EMBED_DEPLOYMENT");

    let scanned = 0;
    let embeddedTotal = 0;

    // Keyset pagination on updatedDate — the cursor advances each page so the
    // next query naturally continues from where the last committed.
    for (;;) {
      const tasks = await this.prisma.clickupTask.findMany({
        where: { workspaceId, isDeleted: false, updatedDate: { gt: cursor }, ...scopeWhere },
        orderBy: { updatedDate: "asc" },
        take: SCAN_PAGE,
      });
      if (tasks.length === 0) break;

      // Page high-water = max updatedDate across ALL durably-correct rows (embedded
      // OR confirmed-unchanged), so an all-skip page still advances the cursor.
      const pageMax = tasks.reduce<Date>(
        (m, t) => (t.updatedDate && t.updatedDate > m ? t.updatedDate : m),
        cursor,
      );

      // Comments folded only for tasks whose comment sync completed.
      const commentTaskIds = tasks.filter((t) => t.commentsSyncedAt).map((t) => t.taskId);
      const commentsByTask = await this.loadComments(commentTaskIds);

      // Build cards + diff against stored hashes.
      const cards = new Map<string, TaskCard>();
      for (const t of tasks) {
        cards.set(t.taskId, buildTaskCard(toCardInput(t), commentsByTask.get(t.taskId) ?? []));
      }
      const existing = await this.prisma.kbChunk.findMany({
        where: {
          workspaceId,
          sourceType: "clickup_task",
          chunkIndex: 0,
          sourceId: { in: tasks.map((t) => t.taskId) },
        },
        select: { sourceId: true, contentHash: true },
      });
      const existingHash = new Map(existing.map((e) => [e.sourceId, e.contentHash]));

      const toEmbed = tasks.filter((t) => cards.get(t.taskId)!.contentHash !== existingHash.get(t.taskId));

      if (toEmbed.length > 0) {
        const vectors = await embedInBatches(
          this.azure,
          toEmbed.map((t) => ({ sourceId: t.taskId, content: cards.get(t.taskId)!.content })),
        );
        // Upsert each embedded chunk + advance the cursor in ONE transaction.
        await this.prisma.$transaction(async (tx) => {
          for (const t of toEmbed) {
            const card = cards.get(t.taskId)!;
            const vec = vectors.get(t.taskId);
            if (!vec) continue;
            await this.upsertChunk(tx, workspaceId, t.taskId, card, vec, model);
          }
          await tx.kbSyncState.update({
            where: { workspaceId },
            data: { lastTaskCursor: pageMax },
          });
        });
        embeddedTotal += toEmbed.length;
      } else {
        // Nothing to embed this page — still advance the cursor (crash-safe: no
        // un-embedded rows are left behind, since all were unchanged).
        await this.prisma.kbSyncState.update({
          where: { workspaceId },
          data: { lastTaskCursor: pageMax },
        });
      }

      scanned += tasks.length;
      cursor = pageMax;
      await this.emit(
        workspaceId,
        "onboarding",
        embeddedTotal,
        total,
        `Embedded ${embeddedTotal} (scanned ${scanned}/${total})`,
      );

      if (tasks.length < SCAN_PAGE) break;
    }

    // Purge-on-narrow: after a SCOPED embed, delete clickup_task chunks whose task no
    // longer matches the declared scope, so re-onboarding to a narrower scope shrinks
    // the KB instead of leaving stale out-of-scope chunks searchable.
    if (Object.keys(scopeWhere).length > 0) {
      const inScope = await this.prisma.clickupTask.findMany({
        where: { workspaceId, isDeleted: false, ...scopeWhere },
        select: { taskId: true },
      });
      const ids = inScope.map((t) => t.taskId);
      if (ids.length === 0) {
        // ensureCoverage no-ops when Clicksy is unreachable, and folder/list/client
        // filters never trigger backfill, so 0 matches is a realistic TRANSIENT gap.
        // Deleting with notIn:[] would wipe ALL task chunks (Prisma = match-all), so SKIP.
        this.logger.warn(
          `KB purge skipped for ${workspaceId}: scope matched 0 mirrored tasks (kept existing chunks)`,
        );
      } else {
        const purged = await this.prisma.kbChunk.deleteMany({
          where: { workspaceId, sourceType: "clickup_task", sourceId: { notIn: ids } },
        });
        if (purged.count > 0)
          this.logger.log(`KB purge removed ${purged.count} out-of-scope chunk(s) for ${workspaceId}`);
      }
    }

    return embeddedTotal;
  }

  /** Raw upsert so the pgvector `embedding` column can be written (Prisma can't). */
  private async upsertChunk(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    sourceId: string,
    card: TaskCard,
    vec: number[],
    model: string,
  ): Promise<void> {
    const m = card.metadata;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "meetsy"."KbChunk" (
        "id","workspaceId","sourceType","sourceId","chunkIndex","content","contentHash",
        "embedding","status","assignee","component","client","department","taskUpdatedAt",
        "embeddingModel","embeddingDims","embeddingVersion","createdAt","updatedAt"
      ) VALUES (
        ${randomId()}, ${workspaceId}, 'clickup_task'::"meetsy"."KbSourceType", ${sourceId}, 0,
        ${card.content}, ${card.contentHash}, ${toVectorLiteral(vec)}::public.vector,
        ${m.status}, ${m.assignee}, ${m.component}, ${m.client}, ${m.department}, ${m.taskUpdatedAt},
        ${model}, ${EMBED_DIMS}, ${EMBED_VERSION}, now(), now()
      )
      ON CONFLICT ("workspaceId","sourceType","sourceId","chunkIndex") DO UPDATE SET
        "content" = EXCLUDED."content",
        "contentHash" = EXCLUDED."contentHash",
        "embedding" = EXCLUDED."embedding",
        "status" = EXCLUDED."status",
        "assignee" = EXCLUDED."assignee",
        "component" = EXCLUDED."component",
        "client" = EXCLUDED."client",
        "department" = EXCLUDED."department",
        "taskUpdatedAt" = EXCLUDED."taskUpdatedAt",
        "embeddingModel" = EXCLUDED."embeddingModel",
        "embeddingDims" = EXCLUDED."embeddingDims",
        "embeddingVersion" = EXCLUDED."embeddingVersion",
        "updatedAt" = now()
    `);
  }

  private async loadComments(taskIds: string[]): Promise<Map<string, CommentCardInput[]>> {
    const out = new Map<string, CommentCardInput[]>();
    if (taskIds.length === 0) return out;
    const rows = await this.prisma.clickupTaskComment.findMany({
      where: { taskId: { in: taskIds }, isDeleted: false },
      orderBy: { commentDate: "asc" },
      select: { taskId: true, commentText: true, userName: true, commentDate: true },
    });
    for (const r of rows) {
      const list = out.get(r.taskId) ?? [];
      list.push({ commentText: r.commentText, userName: r.userName, commentDate: r.commentDate });
      out.set(r.taskId, list);
    }
    return out;
  }

  private async emit(
    workspaceId: string,
    status: string,
    embedded: number,
    total: number,
    message: string,
  ): Promise<void> {
    await this.queue.publishProgress({ workspaceId, status, embedded, total, message, at: Date.now() });
  }

  /**
   * Mark a workspace's onboarding as failed from the worker's `failed` event —
   * the only path that catches a terminal stalled-out job (which never re-enters
   * process()). Best-effort + idempotent: swallows errors so the handler can't
   * crash, and re-running it after the catch block already set "error" is a no-op.
   */
  private async markFailed(workspaceId: string | undefined, message: string): Promise<void> {
    if (!workspaceId) return;
    await this.prisma.kbSyncState
      .update({ where: { workspaceId }, data: { status: "error" } })
      .catch(() => undefined);
    await this.emit(workspaceId, "error", 0, 0, message).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

function randomId(): string {
  // KbChunk.id only matters on INSERT (the unique constraint dedupes upserts).
  return `kbc_${randomUUID()}`;
}

/** Map a public.clickup_tasks read-model row onto the card builder's input. */
function toCardInput(t: {
  taskId: string;
  taskName: string;
  description: string | null;
  status: string | null;
  priority: string | null;
  assigneesNames: string | null;
  listName: string | null;
  folderName: string | null;
  spaceName: string | null;
  client: string | null;
  department: string | null;
  executiveName: string | null;
  sprintName: string | null;
  tags: string | null;
  createdDate: Date | null;
  updatedDate: Date | null;
  dueDate: Date | null;
  startDate: Date | null;
  closedDate: Date | null;
  commentsSyncedAt: Date | null;
}): TaskCardInput {
  return t;
}
