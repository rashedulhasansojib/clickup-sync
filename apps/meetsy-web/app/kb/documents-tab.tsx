"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type KbDocumentRow } from "@/lib/api";
import { Button, Card, ErrorBanner, Spinner, Tag } from "@/app/ui";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Documents tab — upload / list / delete SOP + reference docs. Extracted from
 * the onboarding wizard's `DocumentsStep` for v2 Phase 4 `/kb`. Owner/Admin
 * gates come from the backend (upload + delete 403 for members); the list
 * itself is any-authed and always renders.
 */
export function DocumentsTab({ ws, canWrite }: { ws: string; canWrite: boolean }) {
  const [docs, setDocs] = useState<KbDocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await api.kbListDocuments(ws);
      const list = Array.isArray(rows)
        ? rows
        : ((rows as { documents?: KbDocumentRow[] } | null)?.documents ?? []);
      setDocs(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(messageOf(err, "Could not load documents."));
    } finally {
      setLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    void load();
  }, [load]);

  const onUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setUploading(true);
      setUploadError(null);
      try {
        await api.kbUploadDocument(ws, file);
        await load();
      } catch (err) {
        setUploadError(messageOf(err, "Could not upload the document."));
      } finally {
        setUploading(false);
      }
    },
    [ws, load],
  );

  const onDelete = useCallback(
    async (docId: string) => {
      try {
        await api.kbDeleteDocument(ws, docId);
        await load();
      } catch (err) {
        setUploadError(messageOf(err, "Could not delete the document."));
      }
    },
    [ws, load],
  );

  return (
    <Card className="space-y-5 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">
          SOPs &amp; reference documents
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Upload process docs, style guides, or definitions so Meetsy can ground
          its suggestions in how your team actually works.
        </p>
      </div>

      {canWrite && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50">
            <input
              type="file"
              onChange={onUpload}
              disabled={uploading}
              className="hidden"
            />
            {uploading ? <Spinner label="Uploading…" /> : "Upload a document"}
          </label>
        </div>
      )}

      {uploadError && <ErrorBanner message={uploadError} />}

      <div className="space-y-2">
        {loading ? (
          <Spinner label="Loading documents…" />
        ) : loadError ? (
          <ErrorBanner message={loadError} />
        ) : docs.length === 0 ? (
          <p className="text-sm text-zinc-500">No documents yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
            {docs.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-zinc-700">
                  {doc.filename ?? doc.name ?? doc.id}
                  {doc.status && (
                    <span className="ml-2">
                      <Tag>{doc.status}</Tag>
                    </span>
                  )}
                </span>
                {canWrite && (
                  <Button
                    variant="danger"
                    className="px-2 py-1 text-xs"
                    onClick={() => onDelete(doc.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
