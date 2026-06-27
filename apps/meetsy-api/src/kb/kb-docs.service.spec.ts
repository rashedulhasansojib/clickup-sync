import { BadRequestException } from "@nestjs/common";
import { KbDocsService } from "./kb-docs.service";
import { PrismaService } from "../prisma/prisma.service";
import { KbDocsQueue } from "./kb-docs.queue";

function makeService(existing: { id: string; status: string } | null) {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const create = jest.fn().mockResolvedValue({ id: "doc_new" });
  const update = jest.fn().mockResolvedValue({});
  const findUnique = jest.fn().mockResolvedValue(existing);
  const prisma = { kbDocument: { findUnique, create, update } } as unknown as PrismaService;
  const queue = { enqueue } as unknown as KbDocsQueue;
  return { svc: new KbDocsService(prisma, queue), enqueue, create, update, findUnique };
}

const md = (s: string) => ({ filename: "x.md", mimeType: "text/markdown", buffer: Buffer.from(s) });

describe("KbDocsService.upload", () => {
  it("rejects an unsupported mime type", async () => {
    const { svc } = makeService(null);
    await expect(
      svc.upload("ws1", { filename: "x.bin", mimeType: "application/octet-stream", buffer: Buffer.from("x") }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an empty upload", async () => {
    const { svc } = makeService(null);
    await expect(svc.upload("ws1", md(""))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("creates + enqueues a new document", async () => {
    const { svc, create, enqueue } = makeService(null);
    const out = await svc.upload("ws1", md("hello world"));
    expect(out).toEqual({ id: "doc_new", status: "pending", deduped: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("dedups identical bytes against a ready doc WITHOUT re-enqueuing", async () => {
    const { svc, create, enqueue } = makeService({ id: "doc_old", status: "ready" });
    const out = await svc.upload("ws1", md("hello world"));
    expect(out).toEqual({ id: "doc_old", status: "ready", deduped: true });
    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-runs a prior ERRORED doc on re-upload (resets to pending + enqueues)", async () => {
    const { svc, update, enqueue } = makeService({ id: "doc_err", status: "error" });
    const out = await svc.upload("ws1", md("hello world"));
    expect(out).toEqual({ id: "doc_err", status: "pending", deduped: true });
    expect(update).toHaveBeenCalledWith({ where: { id: "doc_err" }, data: { status: "pending", error: null } });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
