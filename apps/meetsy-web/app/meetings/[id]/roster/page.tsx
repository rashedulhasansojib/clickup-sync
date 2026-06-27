"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Participant } from "@ma/shared";
import { api, ApiError } from "@/lib/api";
import { loadMeeting, clearMeeting } from "@/lib/store";
import { Button, Card, ErrorBanner, Spinner, Tag } from "@/app/ui";

export default function RosterPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const meetingId = params.id;

  const [roster, setRoster] = useState<Participant[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [foundInStore, setFoundInStore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the extracted roster from the upload step (sessionStorage).
  // There is no GET /meetings/:id, so this is the only source for the roster.
  useEffect(() => {
    const stored = loadMeeting(meetingId);
    if (stored) {
      setRoster(stored.roster);
      setFoundInStore(true);
    }
    setHydrated(true);
  }, [meetingId]);

  function updateName(id: string, displayName: string) {
    setRoster((prev) =>
      prev.map((p) => (p.id === id ? { ...p, displayName } : p)),
    );
  }

  function removePerson(id: string) {
    setRoster((prev) => prev.filter((p) => p.id !== id));
  }

  function addPerson() {
    const n = roster.length + 1;
    setRoster((prev) => [
      ...prev,
      { id: `manual-${Date.now()}`, displayName: `Person ${n}`, aliases: [] },
    ]);
  }

  async function handleConfirm() {
    setError(null);
    const cleaned = roster
      .map((p) => ({ ...p, displayName: p.displayName.trim() }))
      .filter((p) => p.displayName.length > 0);

    if (cleaned.length === 0) {
      setError("Add at least one participant before continuing.");
      return;
    }

    setSubmitting(true);
    try {
      const { runId } = await api.confirmRoster(meetingId, { roster: cleaned });
      clearMeeting(meetingId);
      router.push(`/runs/${runId}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not confirm the roster.",
      );
      setSubmitting(false);
    }
  }

  if (!hydrated) {
    return <Spinner label="Loading roster…" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Confirm the participants
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Confirm the participants before we assign tasks. Edit names, remove
          anyone who isn&apos;t a real attendee, or add someone the extractor
          missed.
        </p>
      </div>

      {!foundInStore && (
        <ErrorBanner
          message="We couldn't find the extracted roster for this meeting (it may have expired). You can still add participants manually below, or start over from the upload page."
        />
      )}

      {error && <ErrorBanner message={error} />}

      <Card>
        <ul className="divide-y divide-zinc-100">
          {roster.length === 0 && (
            <li className="px-6 py-10 text-center text-sm text-zinc-400">
              No participants yet. Add one to continue.
            </li>
          )}
          {roster.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-3 px-6 py-4"
            >
              <div className="flex-1 space-y-1.5">
                <label htmlFor={`name-${p.id}`} className="sr-only">
                  Participant name
                </label>
                <input
                  id={`name-${p.id}`}
                  type="text"
                  value={p.displayName}
                  onChange={(e) => updateName(p.id, e.target.value)}
                  disabled={submitting}
                  className="w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
                />
                {p.aliases.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-zinc-400">aliases:</span>
                    {p.aliases.map((a, i) => (
                      <Tag key={`${p.id}-${i}`}>{a}</Tag>
                    ))}
                  </div>
                )}
              </div>
              <Button
                type="button"
                variant="danger"
                onClick={() => removePerson(p.id)}
                disabled={submitting}
                aria-label={`Remove ${p.displayName}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="border-t border-zinc-100 px-6 py-4">
          <Button
            type="button"
            variant="secondary"
            onClick={addPerson}
            disabled={submitting}
          >
            + Add participant
          </Button>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push("/")}
          disabled={submitting}
        >
          ← Back to upload
        </Button>
        <div className="flex items-center gap-3">
          {submitting && <Spinner label="Starting analysis…" />}
          <Button type="button" onClick={handleConfirm} disabled={submitting}>
            {submitting ? "Starting…" : "Confirm & analyze"}
          </Button>
        </div>
      </div>
    </div>
  );
}
