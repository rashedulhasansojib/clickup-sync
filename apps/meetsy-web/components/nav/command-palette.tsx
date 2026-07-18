"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Home,
  ListChecks,
  Plus,
  Send,
  Sparkles,
} from "lucide-react";
import { api, ApiError, type KbSearchHit } from "@/lib/api";
import type { AuthPrincipal } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace-context";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

interface NavEntry {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  ownerAdminOnly?: boolean;
}

const NAV_ENTRIES: NavEntry[] = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/new", label: "New meeting", icon: Plus },
  { href: "/meetings", label: "Meetings", icon: ListChecks },
  { href: "/learning", label: "Learning", icon: Sparkles },
  { href: "/kb", label: "Knowledge base", icon: BookOpen },
  { href: "/settings/push", label: "Push settings", icon: Send, ownerAdminOnly: true },
];

/**
 * v2 Phase 4 (PR-S) — global ⌘K command palette. Mounted inside `SignedInShell`.
 * Two groups: static navigation shortcuts + a debounced live search against
 * `/kb/search`. Selecting a search hit navigates to `/kb?tab=search&q=…` so the
 * hit renders in context; the palette itself is a nav shortcut, not a data view.
 */
export function CommandPalette({ user }: { user: AuthPrincipal }) {
  const router = useRouter();
  const { activeWorkspaceId } = useWorkspace();
  const canSeeAdmin = user.role === "OWNER" || user.role === "ADMIN";
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<KbSearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  // Global toggle: ⌘K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset transient state whenever the palette closes.
  useEffect(() => {
    if (!open) {
      setQ("");
      setHits([]);
      setSearching(false);
    }
  }, [open]);

  // Debounced live search — 250ms. Abort when the query changes so we don't
  // race stale results into the list.
  useEffect(() => {
    if (!open || !activeWorkspaceId) return;
    const query = q.trim();
    if (!query) {
      setHits([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const t = window.setTimeout(() => {
      void api
        .kbSearch(activeWorkspaceId, query, 8)
        .then((res) => {
          if (controller.signal.aborted) return;
          setHits(res);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && err.status === 401) return;
          setHits([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(t);
    };
  }, [q, open, activeWorkspaceId]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const visibleNav = NAV_ENTRIES.filter((e) => !e.ownerAdminOnly || canSeeAdmin);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder={
          activeWorkspaceId
            ? "Search or jump to…"
            : "Loading workspace…"
        }
        value={q}
        onValueChange={setQ}
        disabled={!activeWorkspaceId}
      />
      <CommandList>
        <CommandEmpty>
          {searching ? "Searching…" : "No matches."}
        </CommandEmpty>

        <CommandGroup heading="Go to">
          {visibleNav.map((entry) => {
            const Icon = entry.icon;
            return (
              <CommandItem
                key={entry.href}
                value={`nav ${entry.label}`}
                onSelect={() => go(entry.href)}
              >
                <Icon />
                <span>{entry.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        {hits.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Search knowledge base">
              {hits.map((hit) => (
                <CommandItem
                  key={hit.sourceId}
                  value={`hit ${hit.sourceId} ${hit.snippet}`}
                  onSelect={() =>
                    go(`/kb?tab=search&q=${encodeURIComponent(q.trim())}`)
                  }
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-xs font-mono opacity-70">
                      {hit.sourceId}
                    </span>
                    <span className="line-clamp-1 text-sm">{hit.snippet}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
