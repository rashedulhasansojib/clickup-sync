"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Participant } from "@ma/shared";
import { api, ApiError, type AssignableMember } from "@/lib/api";
import { loadMeeting, clearMeeting } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace-context";
import { Button, Card, ErrorBanner, Spinner, Tag } from "@/app/ui";

/** Normalize a display name for matching: lowercase, trim, collapse whitespace. */
function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Non-trivial tokens (≥2 chars) of a normalized name, for fuzzy matching. */
function nameTokens(name: string): string[] {
  return normalizeName(name)
    .split(" ")
    .filter((t) => t.length >= 2);
}

/**
 * Best local guess for a participant's ClickUp member, used only as a fallback
 * when the backend didn't suggest one. Exact normalized match first, then any
 * member sharing ≥1 non-trivial token with the transcript display name.
 */
function localMatch(
  displayName: string,
  members: AssignableMember[],
): string | null {
  const norm = normalizeName(displayName);
  const exact = members.find((m) => normalizeName(m.name) === norm);
  if (exact) return exact.clickupUserId;

  const tokens = new Set(nameTokens(displayName));
  if (tokens.size === 0) return null;
  const fuzzy = members.find((m) =>
    nameTokens(m.name).some((t) => tokens.has(t)),
  );
  return fuzzy ? fuzzy.clickupUserId : null;
}

export default function RosterPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const meetingId = params.id;
  const { activeWorkspaceId } = useWorkspace();

  const [roster, setRoster] = useState<Participant[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [foundInStore, setFoundInStore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ClickUp members for the per-participant mapping. `null` = still loading;
  // `[]` = none available (incl. the Member 403 → graceful degrade to name-only).
  const [members, setMembers] = useState<AssignableMember[] | null>(null);
  const [membersError, setMembersError] = useState(false);
  // Gate the member-based clickupUserId init to run exactly once.
  const didInitMappingRef = useRef(false);

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

  // Fetch assignable members for the active workspace. GET /clickup/members is
  // Owner/Admin-only — a Member gets a 403 (thrown ApiError, NOT a redirect),
  // which we swallow into `setMembers([])` + `membersError` so name-only editing
  // still works and confirm is never blocked.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let active = true;
    setMembers(null);
    setMembersError(false);
    void api
      .getClickUpMembers(activeWorkspaceId)
      .then((res) => {
        if (!active) return;
        setMembers(res.members);
      })
      .catch(() => {
        if (!active) return;
        setMembers([]);
        setMembersError(true);
      });
    return () => {
      active = false;
    };
  }, [activeWorkspaceId]);

  // Once both the roster is hydrated and members have loaded, initialize each
  // participant's clickupUserId exactly once: prefer the backend's suggestion if
  // it's a valid member, else a local name-match fallback, else null. Runs once
  // (didInitMappingRef) so it never clobbers the user's manual edits.
  useEffect(() => {
    if (!hydrated || !members || members.length === 0) return;
    if (didInitMappingRef.current) return;
    didInitMappingRef.current = true;
    const allowed = new Set(members.map((m) => m.clickupUserId));
    setRoster((prev) =>
      prev.map((p) => {
        const suggested =
          p.clickupUserId && allowed.has(p.clickupUserId)
            ? p.clickupUserId
            : localMatch(p.displayName, members);
        const matched = suggested
          ? (members.find((m) => m.clickupUserId === suggested) ?? null)
          : null;
        return {
          ...p,
          clickupUserId: matched ? matched.clickupUserId : null,
          clickupName: matched ? matched.name : null,
        };
      }),
    );
  }, [hydrated, members]);

  function updateName(id: string, displayName: string) {
    setRoster((prev) =>
      prev.map((p) => (p.id === id ? { ...p, displayName } : p)),
    );
  }

  function updateMember(id: string, clickupUserId: string | null) {
    const matched = clickupUserId
      ? (members?.find((m) => m.clickupUserId === clickupUserId) ?? null)
      : null;
    setRoster((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              clickupUserId: matched ? matched.clickupUserId : null,
              clickupName: matched ? matched.name : null,
            }
          : p,
      ),
    );
  }

  function removePerson(id: string) {
    setRoster((prev) => prev.filter((p) => p.id !== id));
  }

  function addPerson() {
    const n = roster.length + 1;
    setRoster((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        displayName: `Person ${n}`,
        aliases: [],
        clickupUserId: null,
        clickupName: null,
      },
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

                {/* ClickUp member mapping. Hidden entirely on the Member 403
                    (membersError) so name-only editing degrades gracefully. */}
                {members === null && activeWorkspaceId && !membersError ? (
                  <Spinner label="Matching members…" />
                ) : members && members.length > 0 ? (
                  <MemberSelect
                    participant={p}
                    members={members}
                    disabled={submitting}
                    onChange={(id) => updateMember(p.id, id)}
                  />
                ) : null}
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
          onClick={() => router.push("/new")}
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

/**
 * Per-participant ClickUp member picker. Mirrors the assignee `<select>` in
 * `app/runs/[runId]/components.tsx`. Shows a hint when the chosen member's name
 * differs from the transcript display name so the mapping stays transparent.
 */
function MemberSelect({
  participant,
  members,
  disabled,
  onChange,
}: {
  participant: Participant;
  members: AssignableMember[];
  disabled: boolean;
  onChange: (clickupUserId: string | null) => void;
}) {
  const selected = members.find(
    (m) => m.clickupUserId === participant.clickupUserId,
  );
  const showHint =
    selected &&
    normalizeName(selected.name) !== normalizeName(participant.displayName);

  return (
    <div className="space-y-1">
      <label
        htmlFor={`member-${participant.id}`}
        className="flex flex-col text-[11px] text-zinc-400"
      >
        ClickUp member
        <select
          id={`member-${participant.id}`}
          value={participant.clickupUserId ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
          className="mt-0.5 rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none"
        >
          <option value="">Unassigned / no match</option>
          {members.map((m) => (
            <option key={m.clickupUserId} value={m.clickupUserId}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {showHint && selected && (
        <p className="text-xs text-zinc-400">
          transcript: &ldquo;{participant.displayName}&rdquo; → ClickUp: &ldquo;
          {selected.name}&rdquo;
        </p>
      )}
    </div>
  );
}
