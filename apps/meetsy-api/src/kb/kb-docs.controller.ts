import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser, Roles } from "../auth/decorators";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { KbDocsService, MAX_UPLOAD_BYTES } from "./kb-docs.service";

/** The Multer file shape (memory storage). */
interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/**
 * Phase 2b document endpoints — upload context docs (SOPs/scopes/PDFs) into the
 * workspace KB and read their honest improvement metric + doc↔task links.
 * Workspace-scoped + session-authed (global AuthGuard); writes are Owner/Admin.
 */
@Controller("workspaces/:id/kb/documents")
export class KbDocsController {
  constructor(
    private readonly docs: KbDocsService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  /** Upload a document (multipart field `file`). Owner/Admin. */
  @Post()
  @Roles("OWNER", "ADMIN")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
  ) {
    if (!file) throw new BadRequestException("file is required (multipart field 'file')");
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.docs.upload(workspaceId, {
      filename: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      uploadedBy: user.userId,
    });
  }

  /** List the workspace's documents + their status/metric. Any authed user. */
  @Get()
  async list(@CurrentUser() user: AuthPrincipal, @Param("id") id: string) {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.docs.list(workspaceId);
  }

  /** One document: status, metric (novelty + answerability), linked tasks. */
  @Get(":docId")
  async get(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Param("docId") docId: string,
  ) {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.docs.get(workspaceId, docId);
  }

  /** Hard-delete a document (+ its chunks + links). Owner/Admin. */
  @Delete(":docId")
  @Roles("OWNER", "ADMIN")
  async remove(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Param("docId") docId: string,
  ) {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.docs.remove(workspaceId, docId);
  }
}
