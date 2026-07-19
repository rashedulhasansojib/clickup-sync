"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Participant, SuggestionSource } from "@ma/shared";
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
        const backendPickAllowed = p.clickupUserId && allowed.has(p.clickupUserId);
        const suggested = backendPickAllowed
          ? p.clickupUserId
          : localMatch(p.displayName, members);
        const matched = suggested
          ? (members.find((m) => m.clickupUserId === suggested) ?? null)
          : null;
        // Keep the backend's `source` when we're using its suggestion; if we
        // fell back to a local fuzzy match, that's a heuristic pick — relabel.
        // Nothing matched at all → "none".
        const source: SuggestionSource = backendPickAllowed
          ? (p.source ?? "heuristic")
          : matched
            ? "heuristic"
            : "none";
        return {
          ...p,
          clickupUserId: matched ? matched.clickupUserId : null,
          clickupName: matched ? matched.name : null,
          source,
          // Confirmations only meaningful for a KB source; drop it otherwise.
          confirmations: source === "kb" ? p.confirmations : undefined,
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
              // Any explicit member pick clears a prior blocklist intent.
              blocklist: false,
            }
          : p,
      ),
    );
  }

  /**
   * v2 Phase 7 — user marks this name as "never match anyone". Combined with
   * clickupUserId=null, tells the backend to write a blocklist row in the
   * ParticipantAlias KB. Clicking again toggles the intent off.
   */
  function toggleBlocklist(id: string) {
    setRoster((prev) =>
      prev.map((p) =>
        p.id === id
          ? p.blocklist
            ? { ...p, blocklist: false }
            : { ...p, clickupUserId: null, clickupName: null, blocklist: true }
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
      const { runId, learned } = await api.confirmRoster(meetingId, { roster: cleaned });
      clearMeeting(meetingId);
      // v2 Phase 7 — surface what the roster-memory KB learned this round.
      // Silent when there's nothing informative to say (e.g. all-null roster).
      const parts: string[] = [];
      if (learned.learned) parts.push(`learned ${learned.learned}`);
      if (learned.corrected) parts.push(`corrected ${learned.corrected}`);
      if (learned.blocklisted) parts.push(`blocklisted ${learned.blocklisted}`);
      if (parts.length > 0) {
        toast.success(`Meetsy will remember ${parts.join(", ")} for this workspace.`);
      } else if (learned.kept > 0) {
        toast.message(`Reinforced ${learned.kept} known mapping${learned.kept === 1 ? "" : "s"}.`);
      }
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
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Confirm the participants
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
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
        <ul className="divide-y divide-border">
          {roster.length === 0 && (
            <li className="px-6 py-10 text-center text-sm text-muted-foreground/70">
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
                  className="w-full rounded-lg border border-input px-3 py-1.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring"
                />
                {p.aliases.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground/70">aliases:</span>
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
                  <div className="space-y-1.5">
                    <MemberSelect
                      participant={p}
                      members={members}
                      disabled={submitting || p.blocklist === true}
                      onChange={(id) => updateMember(p.id, id)}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <SourceBadge participant={p} />
                      <button
                        type="button"
                        onClick={() => toggleBlocklist(p.id)}
                        disabled={submitting}
                        className="text-[11px] font-medium text-muted-foreground/80 underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-50"
                        aria-pressed={p.blocklist === true}
                      >
                        {p.blocklist
                          ? "Undo — allow matching"
                          : "Never match this name"}
                      </button>
                    </div>
                  </div>
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
        <div className="border-t border-border px-6 py-4">
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
 * v2 Phase 7 — small provenance chip next to each roster member picker.
 *
 * Reads `Participant.source` (the resolver tier that produced the suggestion at
 * upload time) + `Participant.blocklist` (a transient UI flag from the "Never
 * match this name" button). Renders semantic color + short label so the user
 * can tell an authoritative KB suggestion from a heuristic guess at a glance.
 *
 * `source` is undefined on legacy rosters (pre-Phase-7); we render nothing then,
 * matching the badge-less UI those users are used to.
 */
function SourceBadge({ participant }: { participant: Participant }) {
  if (participant.blocklist) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
        <span aria-hidden>⛔</span>
        <span>Blocklisted — won&apos;t suggest again</span>
      </span>
    );
  }
  const source = participant.source;
  if (!source) return null;
  const badgeFor: Record<SuggestionSource, { className: string; label: string; icon: string } | null> = {
    kb: {
      className:
        "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      label:
        participant.confirmations && participant.confirmations > 0
          ? `KB · confirmed ${participant.confirmations}×`
          : "KB match",
      icon: "⭐",
    },
    heuristic: {
      className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
      label: "Heuristic match",
      icon: "🔍",
    },
    llm: {
      className: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
      label: "AI guess",
      icon: "✨",
    },
    none: {
      className:
        "bg-muted text-muted-foreground",
      label: "No match yet",
      icon: "⚪",
    },
  };
  const cfg = badgeFor[source];
  if (!cfg) return null;
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cfg.className}`}
      title={
        source === "kb"
          ? "Suggested from this workspace's learned aliases — the KB got smarter from prior corrections."
          : source === "heuristic"
            ? "Suggested by name-matching against the ClickUp allowlist. Confirming this will teach the KB."
            : source === "llm"
              ? "Suggested by AI when the KB and name-match both missed."
              : "No resolver tier produced a match — pick a member (or add one) to teach Meetsy for next time."
      }
    >
      <span aria-hidden>{cfg.icon}</span>
      <span>{cfg.label}</span>
    </span>
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
        className="flex flex-col text-[11px] text-muted-foreground/70"
      >
        ClickUp member
        <select
          id={`member-${participant.id}`}
          value={participant.clickupUserId ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
          className="mt-0.5 rounded-md border border-input px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
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
        <p className="text-xs text-muted-foreground/70">
          transcript: &ldquo;{participant.displayName}&rdquo; → ClickUp: &ldquo;
          {selected.name}&rdquo;
        </p>
      )}
    </div>
  );
}
