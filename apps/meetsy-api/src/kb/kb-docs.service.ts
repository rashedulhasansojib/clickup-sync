import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { KbDocsQueue } from "./kb-docs.queue";
import { isSupportedMime, SUPPORTED_MIMES } from "./doc-extract";

/** The honest improvement metric stored on KbDocument.metric (never blended). */
export interface KbDocMetric {
  novelty: {
    chunkCount: number;
    novelChunkCount: number;
    pctNovel: number;
    medianNovelty: number;
    comparedAgainst: number;
  };
  /** null when no questions were derivable / Azure unavailable. */
  answerability: {
    provisional: boolean;
    questionSource: "transcript" | "task";
    questionCount: number;
    answerableBefore: number;
    answerableAfter: number;
    newlyAnswerable: number;
    regressions: number;
    questions: Array<{ question: string; answerableBefore: boolean; answerableAfter: boolean }>;
  } | null;
  computedAt: string;
}

/** 25 MB hard cap on uploaded bytes (page cap is enforced post-parse). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy?: string;
}

@Injectable()
export class KbDocsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: KbDocsQueue,
  ) {}

  /**
   * Accept an upload: validate type/size, dedup by content sha256, persist a
   * pending KbDocument, and enqueue the parse→embed→metric job. Re-uploading
   * identical bytes returns the existing doc (no duplicate work).
   */
  async upload(workspaceId: string, input: UploadInput): Promise<{ id: string; status: string; deduped: boolean }> {
    if (!isSupportedMime(input.mimeType)) {
      throw new BadRequestException(
        `Unsupported document type: ${input.mimeType}. Supported: ${SUPPORTED_MIMES.join(", ")}`,
      );
    }
    if (input.buffer.byteLength === 0) throw new BadRequestException("Empty upload");
    if (input.buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`);
    }

    const sha256 = createHash("sha256").update(input.buffer).digest("hex");
    const existing = await this.prisma.kbDocument.findUnique({
      where: { workspaceId_sha256: { workspaceId, sha256 } },
    });
    if (existing) {
      // Identical bytes already here. Re-run only if a prior attempt errored.
      if (existing.status === "error") {
        await this.prisma.kbDocument.update({ where: { id: existing.id }, data: { status: "pending", error: null } });
        await this.queue.enqueue({ workspaceId, documentId: existing.id, buffer: input.buffer.toString("base64"), mimeType: input.mimeType });
        return { id: existing.id, status: "pending", deduped: true };
      }
      return { id: existing.id, status: existing.status, deduped: true };
    }

    const doc = await this.prisma.kbDocument.create({
      data: {
        workspaceId,
        filename: input.filename,
        mimeType: input.mimeType,
        sha256,
        byteSize: input.buffer.byteLength,
        status: "pending",
        uploadedBy: input.uploadedBy ?? null,
      },
    });
    // The raw bytes ride along on the job (not persisted on the row); the worker
    // extracts text, persists the TEXT, and discards the bytes.
    await this.queue.enqueue({ workspaceId, documentId: doc.id, buffer: input.buffer.toString("base64"), mimeType: input.mimeType });
    return { id: doc.id, status: "pending", deduped: false };
  }

  async list(workspaceId: string) {
    const docs = await this.prisma.kbDocument.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, filename: true, mimeType: true, byteSize: true, pageCount: true,
        charCount: true, chunkCount: true, status: true, error: true, metric: true,
        uploadedBy: true, createdAt: true,
      },
    });
    return docs;
  }

  async get(workspaceId: string, documentId: string) {
    const doc = await this.prisma.kbDocument.findFirst({
      where: { id: documentId, workspaceId },
      include: { links: { orderBy: { score: "desc" } } },
    });
    if (!doc) throw new NotFoundException("Document not found");
    // Drop the (potentially large) extracted text from the detail payload.
    const { extractedText: _omit, ...rest } = doc;
    return rest;
  }

  /** Hard-delete: doc row (cascades links) + its KB chunks. */
  async remove(workspaceId: string, documentId: string): Promise<{ deleted: boolean }> {
    const doc = await this.prisma.kbDocument.findFirst({ where: { id: documentId, workspaceId } });
    if (!doc) throw new NotFoundException("Document not found");
    await this.prisma.$transaction([
      this.prisma.kbChunk.deleteMany({ where: { workspaceId, sourceType: "document", sourceId: documentId } }),
      this.prisma.kbDocument.delete({ where: { id: documentId } }),
    ]);
    return { deleted: true };
  }
}
