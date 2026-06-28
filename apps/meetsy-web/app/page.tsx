"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CreateMeetingRequest } from "@ma/shared";
import { api, ApiError, type ClientOption } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import { saveMeeting } from "@/lib/store";
import { Button, Card, ErrorBanner, Spinner } from "@/app/ui";

const ACCEPTED = ".txt,.vtt";

/**
 * Try to extract a meeting date (ISO `YYYY-MM-DD`) from a transcript filename.
 * Zoom names recordings like `GMT20260616-125727_Recording.transcript.vtt`,
 * where the date is encoded as `GMT<YYYY><MM><DD>`. Returns null if no match.
 */
function parseDateFromFileName(name: string): string | null {
  const m = name.match(/GMT(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export default function UploadPage() {
  const router = useRouter();
  const { activeWorkspaceId } = useWorkspace();
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The workspace's client dropdown options (the source of truth for the
  // meeting's client). Empty when the workspace has no client field configured.
  const [clientOptions, setClientOptions] = useState<ClientOption[]>([]);
  const [clientOptionId, setClientOptionId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load the client options for the active workspace. Fail-open: any null/throw
  // leaves `clientOptions` empty, so upload still proceeds without a client.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let active = true;
    // Reset any prior selection when the workspace changes — its options differ,
    // so a stale id would silently submit with no client (and fail the required
    // check on the wrong set).
    setClientOptionId("");
    void (async () => {
      try {
        const cfg = await api.getPushConfig(activeWorkspaceId);
        if (active) setClientOptions(cfg?.clientOptions ?? []);
      } catch {
        if (active) setClientOptions([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [activeWorkspaceId]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      setTranscript(text);
      setFileName(file.name);
      if (!title) setTitle(file.name.replace(/\.(txt|vtt)$/i, ""));
      // Auto-fill the meeting date from the filename (e.g. Zoom recordings);
      // don't clobber a date the user already entered.
      if (!meetingDate) {
        const parsed = parseDateFromFileName(file.name);
        if (parsed) setMeetingDate(parsed);
      }
    } catch {
      setError("Could not read that file. Try pasting the transcript instead.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const body: CreateMeetingRequest = {
      title: title.trim(),
      transcript: transcript.trim(),
      // Optional; JSON.stringify drops `undefined`, so a blank date is omitted.
      meetingDate: meetingDate || undefined,
    };
    if (!body.title) {
      setError("Please give the meeting a title.");
      return;
    }
    if (!body.transcript) {
      setError("Paste a transcript or upload a .txt / .vtt file.");
      return;
    }
    // When the workspace has a client field, a client is required for the whole
    // meeting (still editable per-task at push).
    if (clientOptions.length > 0) {
      if (!clientOptionId) {
        setError("Please choose a client for this meeting.");
        return;
      }
      const chosen = clientOptions.find((o) => o.optionId === clientOptionId);
      if (chosen) {
        body.clientOptionId = chosen.optionId;
        body.clientName = chosen.name;
      }
    }

    setSubmitting(true);
    try {
      const res = await api.createMeeting(body);
      saveMeeting(res);
      router.push(`/meetings/${res.meetingId}/roster`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong creating the meeting.",
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Analyze a meeting transcript
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Paste a transcript or upload a file. We&apos;ll extract the
          participants, then turn the discussion into grounded, assignable
          tasks.
        </p>
      </div>

      <Card>
        <form onSubmit={handleSubmit} className="space-y-5 p-6">
          {error && <ErrorBanner message={error} />}

          <div className="space-y-1.5">
            <label
              htmlFor="title"
              className="block text-sm font-medium text-zinc-700"
            >
              Meeting title
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q3 Planning — Engineering Sync"
              maxLength={300}
              disabled={submitting}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="meetingDate"
              className="block text-sm font-medium text-zinc-700"
            >
              Meeting date{" "}
              <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <input
              id="meetingDate"
              type="date"
              value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
              disabled={submitting}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
            />
            <p className="text-xs text-zinc-400">
              Anchors relative due dates like &ldquo;by Wednesday.&rdquo;
              Auto-filled from Zoom filenames when possible.
            </p>
          </div>

          {clientOptions.length > 0 ? (
            <div className="space-y-1.5">
              <label
                htmlFor="client"
                className="block text-sm font-medium text-zinc-700"
              >
                Client
              </label>
              <select
                id="client"
                value={clientOptionId}
                onChange={(e) => setClientOptionId(e.target.value)}
                disabled={submitting}
                required
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
              >
                <option value="">Select a client…</option>
                {clientOptions.map((o) => (
                  <option key={o.optionId} value={o.optionId}>
                    {o.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-zinc-400">
                Applies to the whole meeting. You can still change it per task
                when pushing to ClickUp.
              </p>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">
              No client field configured for this workspace.
            </p>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="transcript"
                className="block text-sm font-medium text-zinc-700"
              >
                Transcript
              </label>
              <div className="flex items-center gap-3">
                {fileName && (
                  <span className="text-xs text-zinc-400">
                    Loaded {fileName}
                  </span>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={submitting}
                >
                  Upload .txt / .vtt
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED}
                  onChange={handleFile}
                  className="hidden"
                  aria-label="Upload transcript file"
                />
              </div>
            </div>
            <textarea
              id="transcript"
              value={transcript}
              onChange={(e) => {
                setTranscript(e.target.value);
                if (fileName) setFileName(null);
              }}
              placeholder="Paste your meeting transcript here…"
              rows={14}
              disabled={submitting}
              className="w-full resize-y rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm leading-relaxed outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
            />
            <p className="text-xs text-zinc-400">
              {transcript.length.toLocaleString()} characters
            </p>
          </div>

          <div className="flex items-center justify-end gap-3">
            {submitting && <Spinner label="Extracting roster…" />}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Working…" : "Continue"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
