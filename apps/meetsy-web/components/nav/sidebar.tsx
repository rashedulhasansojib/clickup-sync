"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BookOpen,
  Home,
  ListChecks,
  Menu,
  Plus,
  Send,
  Sliders,
  Sparkles,
} from "lucide-react";
import type { AuthPrincipal } from "@/lib/auth";
import { WorkspaceSwitcher } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Persistent left navigation for the signed-in shell. Renders as a fixed
 * 256px rail on `md+`; on smaller screens it collapses into an off-canvas
 * sheet triggered by a hamburger in the top bar.
 *
 * Active-route highlighting matches the current pathname's PREFIX, so nested
 * paths (e.g. `/settings/kb/documents`) still highlight their parent nav item.
 * `/runs/:id` intentionally matches nothing — it's reached from Home/Meetings.
 */

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  ownerAdminOnly?: boolean;
}

const PRIMARY: NavItem[] = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/new", label: "New meeting", icon: Plus },
  { href: "/meetings", label: "Meetings", icon: ListChecks },
  { href: "/learning", label: "Learning", icon: Sparkles },
  // v2 Phase 4 — the consolidated `/kb` route. Replaces the buried `/settings/kb`
  // link (still resolves via a redirect for external bookmarks).
  { href: "/kb", label: "Knowledge base", icon: BookOpen },
];

const SETTINGS: NavItem[] = [
  { href: "/settings/push", label: "Push settings", icon: Send, ownerAdminOnly: true },
  // v2 Phase 5 — Owner/Admin-visible entry. Members can navigate directly and
  // see a read-only view; hiding the nav keeps their surface uncluttered.
  { href: "/tuning", label: "Tuning", icon: Sliders, ownerAdminOnly: true },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/home") return pathname === "/home";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarBody({
  user,
  onNavigate,
}: {
  user: AuthPrincipal;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const canSeeSettings = user.role === "OWNER" || user.role === "ADMIN";

  const renderItem = (item: NavItem) => {
    if (item.ownerAdminOnly && !canSeeSettings) return null;
    const active = isActive(pathname, item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-zinc-900 text-white"
            : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
        )}
      >
        <Icon className="h-4 w-4" />
        <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <nav
      aria-label="Primary navigation"
      className="flex h-full flex-col gap-6 p-4"
    >
      <Link
        href="/home"
        onClick={onNavigate}
        className="flex items-center gap-2 px-2"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-900 text-sm font-bold text-white">
          M
        </span>
        <span className="text-lg font-semibold tracking-tight text-zinc-900">
          Meeting Analyzer
        </span>
      </Link>

      <div className="flex flex-col gap-1">{PRIMARY.map(renderItem)}</div>

      <div className="px-2">
        <WorkspaceSwitcher />
      </div>

      {canSeeSettings && (
        <div className="flex flex-col gap-1">
          <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Settings
          </div>
          {SETTINGS.map(renderItem)}
        </div>
      )}

      <div className="mt-auto border-t border-zinc-200 pt-4 text-xs text-zinc-500">
        <div className="truncate px-2" title={user.email ?? "Signed in"}>
          {user.email ?? "Signed in"}
        </div>
      </div>
    </nav>
  );
}

/**
 * Desktop rail + mobile hamburger trigger. The mobile Sheet mounts unconditionally
 * (Radix handles open state); on `md+` it's fully hidden via `md:hidden` and the
 * fixed rail (`hidden md:flex`) takes over.
 */
export function Sidebar({ user }: { user: AuthPrincipal }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <aside className="hidden border-r border-zinc-200 bg-white md:flex md:w-64 md:shrink-0 md:flex-col">
        <SidebarBody user={user} />
      </aside>

      <div className="flex h-14 items-center gap-2 border-b border-zinc-200 bg-white px-4 md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarBody user={user} onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <Link href="/home" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-900 text-sm font-bold text-white">
            M
          </span>
          <span className="text-base font-semibold text-zinc-900">
            Meeting Analyzer
          </span>
        </Link>
      </div>
    </>
  );
}
