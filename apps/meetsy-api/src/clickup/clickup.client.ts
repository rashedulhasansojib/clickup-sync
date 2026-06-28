import { Injectable, Logger } from "@nestjs/common";
import { ClickUpTokenService } from "./clickup-token.service";
import {
  ClickUpFolderNode,
  ClickUpListNode,
  ClickUpMember,
  ClickUpSpaceNode,
  CreatedTask,
  CreateTaskPayload,
} from "./clickup.types";

/**
 * Minimal ClickUp client for Meetsy's write-back, mirroring Clicksy's
 * `clickup.client.ts` shapes but using native `fetch` (Node 22+) and a
 * per-workspace token resolved/decrypted from the shared store. Only the calls
 * Phase 1 needs: create a task, list team members, and walk the space tree for
 * the target-list picker.
 */
@Injectable()
export class ClickUpClient {
  private readonly logger = new Logger(ClickUpClient.name);
  private readonly baseUrl = "https://api.clickup.com/api/v2";

  constructor(private readonly tokens: ClickUpTokenService) {}

  private async request<T>(
    method: "GET" | "POST",
    workspaceId: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { token } = await this.tokens.resolve(workspaceId);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.logger.error(
        `ClickUp ${method} ${path} failed: ${res.status}${detail ? ` — ${detail}` : ""}`,
      );
      throw new Error(`ClickUp ${method} ${path} failed: ${res.status} ${detail}`);
    }
    return (await res.json()) as T;
  }

  /** POST /list/{listId}/task — create a task. Returns its id + url. */
  async createTask(
    workspaceId: string,
    listId: string,
    payload: CreateTaskPayload,
  ): Promise<CreatedTask> {
    const res = await this.request<{ id: string; url?: string }>(
      "POST",
      workspaceId,
      `/list/${listId}/task`,
      payload,
    );
    return {
      id: res.id,
      url: res.url ?? `https://app.clickup.com/t/${res.id}`,
    };
  }

  /**
   * GET /list/{listId}/field — the custom fields available on a list. Used by the
   * Phase-2c.3 "refresh field options" action to discover the client DROPDOWN
   * field + its options ([{optionId(UUID), name}] from `type_config.options`).
   */
  async getListCustomFields(
    workspaceId: string,
    listId: string,
  ): Promise<Array<{ id: string; name: string; type: string; options: Array<{ id: string; name: string }> }>> {
    const res = await this.request<{
      fields?: Array<{
        id: string;
        name?: string;
        type?: string;
        type_config?: { options?: Array<{ id: string; name?: string; label?: string }> };
      }>;
    }>("GET", workspaceId, `/list/${listId}/field`);
    return (res.fields ?? []).map((f) => ({
      id: f.id,
      name: f.name ?? f.id,
      type: f.type ?? "",
      options: (f.type_config?.options ?? []).map((o) => ({ id: o.id, name: o.name ?? o.label ?? o.id })),
    }));
  }

  /** GET /team/{teamId} — the workspace's team members. */
  async getTeamMembers(workspaceId: string): Promise<ClickUpMember[]> {
    const { teamId } = await this.tokens.resolve(workspaceId);
    const res = await this.request<{ team?: { members?: ClickUpMember[] } }>(
      "GET",
      workspaceId,
      `/team/${teamId}`,
    );
    return res.team?.members ?? [];
  }

  /**
   * Walk the workspace's space → folder → list tree for the target-list picker:
   * `GET /team/{teamId}/space`, then per space `GET /space/{id}/folder`
   * (folders → lists) and `GET /space/{id}/list` (folderless lists).
   */
  async getSpaceTree(workspaceId: string): Promise<ClickUpSpaceNode[]> {
    const { teamId } = await this.tokens.resolve(workspaceId);
    const spacesRes = await this.request<{ spaces?: Array<{ id: string | number; name?: string }> }>(
      "GET",
      workspaceId,
      `/team/${teamId}/space?archived=false`,
    );
    const spaces = spacesRes.spaces ?? [];

    const tree: ClickUpSpaceNode[] = [];
    for (const space of spaces) {
      const spaceId = String(space.id);
      const [folders, lists] = await Promise.all([
        this.getFolders(workspaceId, spaceId),
        this.getFolderlessLists(workspaceId, spaceId),
      ]);
      tree.push({
        id: spaceId,
        name: space.name ?? spaceId,
        folders,
        lists,
      });
    }
    return tree;
  }

  private async getFolders(
    workspaceId: string,
    spaceId: string,
  ): Promise<ClickUpFolderNode[]> {
    const res = await this.request<{
      folders?: Array<{
        id: string | number;
        name?: string;
        lists?: Array<{ id: string | number; name?: string }>;
      }>;
    }>("GET", workspaceId, `/space/${spaceId}/folder?archived=false`);
    return (res.folders ?? []).map((f) => ({
      id: String(f.id),
      name: f.name ?? String(f.id),
      lists: (f.lists ?? []).map(toListNode),
    }));
  }

  private async getFolderlessLists(
    workspaceId: string,
    spaceId: string,
  ): Promise<ClickUpListNode[]> {
    const res = await this.request<{
      lists?: Array<{ id: string | number; name?: string }>;
    }>("GET", workspaceId, `/space/${spaceId}/list?archived=false`);
    return (res.lists ?? []).map(toListNode);
  }
}

function toListNode(l: { id: string | number; name?: string }): ClickUpListNode {
  return { id: String(l.id), name: l.name ?? String(l.id) };
}
