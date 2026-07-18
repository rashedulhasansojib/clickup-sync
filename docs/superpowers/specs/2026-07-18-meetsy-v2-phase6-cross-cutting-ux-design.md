# Meetsy v2 — Phase 6: cross-cutting UX polish (dark, keyboard, a11y, mobile) — design

**Date:** 2026-07-18
**Status:** Design (locked before implementation)
**Umbrella plan:** `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md` §3 (Phase 6 row) + §6 success criteria #9.
**Predecessors:**
- Phase 0: `2026-07-18-meetsy-v2-phase0-foundations-design.md`
- Phase 1: `2026-07-18-meetsy-v2-phase1-ia-home-history-design.md`
- Phase 2: `2026-07-18-meetsy-v2-phase2-evidence-review-design.md`
- Phase 3: `2026-07-18-meetsy-v2-phase3-learning-trust-design.md`
- Phase 4: `2026-07-18-meetsy-v2-phase4-kb-consolidation-design.md`
- Phase 5: `2026-07-18-meetsy-v2-phase5-tuning-design.md`

---

## 1. Purpose

The last v2 phase is not a feature phase — it's the trust pass. Phase 0 wired **shadcn/ui**, **`next-themes`** (`defaultTheme="system"`) and the **`.dark`** class variant, but no route was audited to actually work in dark mode: `apps/meetsy-web/**` contains **364** hardcoded `zinc-*` / `slate-*` / `bg-white` uses across ~30 files, so `system=dark` today renders white cards on a dark background. There is no theme toggle in the shell, no keyboard traversal on the review page, no skeleton loaders (every fetching state falls back to a full-page `<Spinner label="…" />`), no `prefers-reduced-motion` guard, and no explicit landmark markup beyond a single `<nav aria-label="Primary navigation">` inside the sidebar.

Phase 6 closes those gaps in four focused PRs. There is **no backend footprint** (row 82 of the umbrella phase table) — every change lives in `apps/meetsy-web` + `packages/shared` is untouched. Same phase discipline as Phases 3–5: four PRs, one atomic commit, journal updated, no `next build` on the verify path (see `meetsy-web-next-build-dev-footgun` memory).

Scope explicitly per umbrella §3 (Phase 6 delivers): *"Dark mode audit, keyboard shortcuts, empty states, skeleton loaders, landmark `<nav>`/`<main>`, focus-ring pass, `prefers-reduced-motion`, mobile-safe review."*

---

## 2. What ships (per PR)

| PR | Slice | Backend | Web |
|---|---|---|---|
| **AA** | Dark-mode palette sweep + theme toggle. | — | Replace hardcoded `zinc-*` / `slate-*` / `bg-white` in application code (not shadcn primitives — those already use tokens) with semantic tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `bg-card`, `border-border`, `bg-accent`, `hover:bg-accent`). Add a new `ThemeToggle` client component (shadcn `DropdownMenu` with Sun/Moon/Laptop icons, three items Light / Dark / System) mounted in `AppShell` top-right — desktop rail floats it above the workspace switcher; mobile top bar floats it opposite the hamburger. |
| **BB** | Keyboard + landmarks + focus. | — | Add `<main id="main-content">` id on the shell's `<main>`; skip-to-main link in `AppShell`. `useReviewKeys(taskRefs)` hook wired into `runs/[runId]/page.tsx` — `j` next task, `k` prev task, `Esc` closes side sheets. Focus-ring pass: audit `<button>` / `<Link>` sites lacking `focus-visible:` and add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`. `aria-current="page"` on active nav link (sidebar). |
| **CC** | Skeleton loaders + empty states. | — | New `components/ui/empty-state.tsx` (icon + title + description + optional action). Replace `<Spinner label="Loading runs…" />` on `/home`, `<Spinner label="Loading meetings…" />` on `/meetings`, `<Spinner label="Loading tasks…" />` on `/kb` tasks-tab with skeleton components matching the target layout (`components/ui/skeleton.tsx` already exists). Wire `EmptyState` on home (no runs), meetings (no results), kb tasks (empty). |
| **DD** | Reduced-motion + mobile-safe review. | — | `globals.css`: `@media (prefers-reduced-motion: reduce)` block that neutralizes `tw-animate-css` motion, sonner slide, sheet transitions (`animation: none !important` on the animated selectors — narrow set). Mobile review page: the person-section header collapses `pl-9` indent to `pl-4` under `md`; task-card action row wraps; the evidence disclosure keeps its space-y stack. `aria-live="polite"` region wrapping the toast root's parent so screen readers hear near-gate toasts. `aria-live="assertive"` for form validation error text (add to the one inline validation the tuning page emits). |

Order: **AA → BB → CC → DD**. AA is independent (pure Tailwind class edits + one new component). BB depends on AA landing first only because the skip-link + focus-ring styles reference semantic tokens introduced in AA. CC and DD are independent of BB and of each other — bundled together only for the atomic-commit discipline.

---

## 3. Design notes (by PR)

### 3.1 PR-AA — palette sweep + theme toggle

**Semantic-token cheat sheet.** shadcn's design tokens (already in `globals.css`) map cleanly to legacy usages:

| Legacy | Semantic | Notes |
|---|---|---|
| `bg-white` | `bg-card` (surfaces) or `bg-background` (page fills) | Depends on whether it's a card body or the page shell. |
| `text-zinc-900` / `text-slate-900` | `text-foreground` | Primary body copy. |
| `text-zinc-600` / `text-zinc-500` | `text-muted-foreground` | Secondary meta text, hints. |
| `text-zinc-400` | `text-muted-foreground/70` (opacity fallback) | Dim/label variant — use sparingly. |
| `border-zinc-200` | `border-border` | Card + separator borders. |
| `bg-zinc-100` (hover) | `bg-accent` | The sidebar's hover fill. |
| `bg-zinc-900 text-white` (active nav) | `bg-primary text-primary-foreground` | Active nav pill. |
| `bg-zinc-200` (avatar chip) | `bg-muted` | Small chip fills. |

Amber/blue/red hues (used for warnings, info banners, priority badges) stay literal — they encode *meaning*, not neutral surface. Add a `dark:` variant only if the light hue is unreadable in dark mode (e.g., `text-amber-600` → `text-amber-500 dark:text-amber-400`). Confirm case-by-case.

**Scope of the sweep.** 30 files under `apps/meetsy-web/app/` + `apps/meetsy-web/components/` per the grep at spec time. Not touched:
- `components/ui/*` — shadcn primitives already use semantic tokens.
- `app/ui-legacy.tsx` — legacy compatibility shim kept for one v1 route; migrated as-needed if a route still imports it after the sweep. Anything not imported gets deleted at the end of the PR.

**ThemeToggle component.** Lives at `components/theme-toggle.tsx`. Uses `useTheme()` from `next-themes`, three menu items with `Sun` / `Moon` / `Laptop` icons from `lucide-react`. Mounted in `AppShell.tsx` — the desktop rail gets it above the workspace switcher inside the sidebar's flow (bottom-right of the sidebar rail, above the email row); the mobile top bar gets it opposite the hamburger. `suppressHydrationWarning` is already on `<html>` per next-themes' setup, so the button renders once the theme has been applied.

**Sidebar dark-mode.** The sidebar's fixed hues (`border-zinc-200 bg-white`) become `border-border bg-background`. Active nav pill flips from `bg-zinc-900 text-white` to `bg-primary text-primary-foreground`.

### 3.2 PR-BB — keyboard + landmarks + focus

**Skip-to-content link.** First focusable element inside `AppShell`'s root; `sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-primary focus:text-primary-foreground focus:px-3 focus:py-2 focus:rounded-md focus:z-50`. Targets `#main-content` on the shell's `<main>`.

**`useReviewKeys` hook.** New in `app/runs/[runId]/use-review-keys.ts`. Signature:

```ts
export function useReviewKeys(taskIds: string[]): void;
```

Attaches a `keydown` listener on `window` (SSR-safe via `useEffect`). `j` / `ArrowDown` → focus next `[data-task-anchor="${id}"]`, `k` / `ArrowUp` → focus prev. `Esc` blurs any focused element inside `[data-radix-*]` sheet contents — Radix handles Sheet close via its own ESC handler, but the hook adds a fallback for the ClickUp-task detail sheet (`components/tasks/task-detail-sheet.tsx`, not a Radix Sheet). The hook skips when focus is inside an `<input>` / `<textarea>` / `[contenteditable]` so text editing is untouched.

`TaskCard` gets `data-task-anchor={task.id} tabIndex={-1}` (programmatic focus target; not in tab order — Tab still traverses the card's own controls). Focused card gets an outline ring via `focus:ring-2 focus:ring-ring focus:ring-offset-2`.

**Landmarks.** `<main id="main-content" role="main" aria-labelledby="page-title-marker">` — the `role="main"` is redundant with the tag but harmless and belt-and-suspenders across assistive tech. `aria-labelledby` is omitted for now (pages don't consistently render a single title element); the tag itself is the landmark. Sidebar's `<nav aria-label="Primary navigation">` stays as-is.

**`aria-current="page"`** on the active sidebar link (already computed via `isActive(pathname, item.href)`).

**Focus-ring pass.** Audit `<Link>` / `<button>` in application code (not shadcn primitives — they already have `focus-visible:` rings via the `cn(buttonVariants(...))` recipe). Add the standard ring recipe to any lacking it. Bounded scope: header links + sidebar links + a handful of inline `<button className="...">` sites in `runs/[runId]/components.tsx`. If a site is already using shadcn `<Button>` (imported from `@/components/ui/button`), it is already covered.

### 3.3 PR-CC — skeleton + empty states

**`EmptyState` component.** New in `components/ui/empty-state.tsx`:

```tsx
export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; href?: string; onClick?: () => void };
}
```

Renders as a dashed-border card, icon in a muted circle, title, description below, optional action button. Uses semantic tokens (`text-muted-foreground`, `border-border`, `bg-muted`).

**Skeleton components.** Reuse `components/ui/skeleton.tsx` (already installed by shadcn init). Three targets:

- `app/home/page.tsx` — replace the `<Spinner label="Loading runs…" />` block with three `<Skeleton className="h-24 w-full rounded-lg" />` rows matching the run-card list.
- `app/meetings/page.tsx` — replace both `<Spinner>` sites (initial load + search) with a five-row `<Skeleton className="h-16 w-full">` stack.
- `app/kb/tasks-tab.tsx` — replace the `<Spinner label="Loading tasks…" />` with a five-row skeleton matching the tasks table row height.

Other spinner sites stay (button-embedded spinners are fine — they're UI affordances, not layout loaders). The `AppShell` gate spinner stays (pre-auth full-page block).

**Empty-state placements.**

- `/home` — no runs yet: `EmptyState` with `Home` icon + "No meetings analyzed yet" + "Start with **New meeting** to upload your first transcript." + action linking `/new`.
- `/meetings` — no results after search: `EmptyState` with `Search` icon + "No meetings match \"…\"" + no description + no action (the search input above is the action).
- `/kb` tasks tab — no tasks: existing empty text lives in `tasks-tab.tsx` as a `<p className="text-sm text-zinc-500">`; replace with `EmptyState` + `ListChecks` icon.
- `/kb` search tab — no results: existing empty text is already an `EmptyState`-shaped block; leave as-is unless the palette sweep reveals it needs a facelift.

### 3.4 PR-DD — reduced-motion + mobile-safe review

**Reduced motion.** Append to `globals.css`:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0ms !important;
    scroll-behavior: auto !important;
  }
}
```

This nukes shadcn's slide/fade transitions, sonner's toast slide, sheet slides, and any Tailwind `animate-*` utilities in one shot. `!important` is necessary because Tailwind utilities and Radix data-state animations have specificity we can't beat cleanly with cascade order. `disableTransitionOnChange` on `<ThemeProvider>` (already set) covers the theme-flip case.

**Mobile review page.** Three changes in `app/runs/[runId]/components.tsx`:

1. `PersonSection`'s `pl-9` (task list indent below the avatar) becomes `pl-4 md:pl-9` — under `md` the tasks stack flush-left instead of eating half the screen.
2. `TaskCard`'s top row (`<h3>` title + `PriorityBadge`) — the badge is fine; verify the `<h3>` uses `break-words` so long titles wrap rather than overflow the card.
3. `TaskSignals` chip row — already uses `flex flex-wrap`; verify with the palette sweep.

Sheet becomes bottom drawer on mobile: `components/tasks/task-detail-sheet.tsx` currently uses shadcn's `<Sheet side="right">`. Under `md`, we want `side="bottom"`. Cleanest: read the viewport with a `useMediaQuery("(min-width: 768px)")` hook (thin custom impl — no new dep) and toggle `side` per breakpoint. Server-render defaults to `"right"` for hydration parity.

**`aria-live` regions.** Sonner's toast root already declares `role="status"` internally; no extra wrapper needed. Form validation on `/tuning` renders errors as inline text — wrap those in `<p role="alert" aria-live="assertive">` for screen readers.

---

## 4. Deferred / out of scope

- **Comprehensive a11y audit** — Phase 6 hits landmarks + focus + reduced motion + skip-link + `aria-current` + form-error `aria-live`. It does NOT do a full axe scan or WCAG contrast pass; that's a follow-up if the product needs formal AA compliance.
- **RTL support.** Every layout still assumes LTR (`flex flex-row`, `pl-9`). Not on the roadmap.
- **Command palette dark-mode preview.** `⌘K` (Phase 4) uses `<CommandDialog>` from shadcn — already token-based, no dark-mode work needed.
- **In-app "keyboard shortcuts" help sheet.** Bind `?` to show a shortcut cheatsheet — deferred to Phase 6.x once we see how ICs use `j`/`k`.
- **`next build` on the verify path.** Blocked by the shared-`.next` footgun with `next dev` running; verify remains typecheck + lint.

---

## 5. Landmines & mitigations

| Landmine | Mitigation |
|---|---|
| **Palette sweep changes contrast in light mode by accident.** `text-zinc-400` → `text-muted-foreground` alters shade — if the previous shade was tuned intentionally, the swap looks washed out. | Manual spot check of the primary routes (`/home`, `/meetings`, `/kb`, `/runs/:id`, `/tuning`, `/learning`) after the sweep. When the swap would degrade contrast, keep the literal palette. |
| **`next-themes` flash on first paint.** Server renders one theme; client hydrates the other → FOUC. | Already mitigated by `attribute="class"` on `<html>` + `suppressHydrationWarning`. Verified in Phase 0 setup. |
| **`useReviewKeys` fires while typing in the feedback textarea.** j/k would advance instead of typing. | Hook guards on `event.target` being `<input>`/`<textarea>`/`[contenteditable]` and returns early. |
| **`focus-visible:` in old browsers.** Safari < 15.4 doesn't support `:focus-visible`. | Tailwind polyfills via the `focus-visible` variant handling; Safari 15.4+ is our floor. Documented. |
| **Reduced-motion `!important` breaks sonner dismiss animation.** Toast still needs to leave the DOM. | Sonner uses `data-state="closed"` + JS unmount independent of the CSS transition; `animation-duration: 0ms` just makes the exit instant. No functional break. |
| **Skeleton mismatch when the real content lands.** If skeleton height ≠ real row height, layout jumps. | Use approximate heights (`h-16`, `h-24`) matching the real card sizes measured in dev. Not pixel-perfect — the jump is acceptable per shadcn's own skeleton usage. |
| **Mobile sheet flip re-renders during resize.** `useMediaQuery` swaps `side="right"` ↔ `side="bottom"` mid-frame, Radix Sheet unmounts. | Only reads media query once on mount; ignores subsequent resize (rare user flow). Documented in the hook JSDoc. |

---

## 6. Verification

- **Web smoke**: `tsc --noEmit` clean on `apps/meetsy-web`; `next lint` clean.
- **API smoke**: `npm --workspace apps/meetsy-api test` still green (should be — no API changes). Confirm no accidental drift.
- **Manual dark-mode pass**: after PR-AA, click the theme toggle on each primary route and eyeball. Any residual white-on-black cards are palette-sweep misses; sweep more.
- **Manual keyboard pass**: after PR-BB, land on `/runs/:id`, hit `j`/`k` to traverse tasks, `Esc` closes the task-detail sheet, Tab reaches every action.
- **Manual reduced-motion pass**: after PR-DD, macOS System Settings → Accessibility → Display → Reduce Motion, reload — transitions are visibly gone.
- **`next build`** intentionally NOT run (see `meetsy-web-next-build-dev-footgun` memory).

Total expected delta: **no new tests** (this phase is CSS/JSX polish; unit tests would be re-writing shadcn's tests). Verified via typecheck + lint + manual QA. Journal records the manual-pass steps for the record.

---

## 7. Success criteria

Phase 6 is done when:

1. `/home`, `/meetings`, `/kb`, `/runs/:id`, `/tuning`, `/learning`, `/settings/push` all render correctly in **light + dark + system** modes.
2. A **theme toggle** is visible in the shell (desktop + mobile) and cycles Light / Dark / System without flash.
3. On `/runs/:id`, `j`/`k` moves focus between tasks; `Esc` closes the task-detail sheet.
4. A **skip-to-content** link is the first focusable element on any signed-in page.
5. Skeleton loaders replace full-page spinners on `/home`, `/meetings`, `/kb` tasks tab.
6. `EmptyState` renders on empty-list surfaces (home no-runs, meetings no-results, kb no-tasks).
7. `prefers-reduced-motion: reduce` visibly disables sheet/toast/animation transitions.
8. Mobile review page (`< md`) doesn't overflow horizontally; task-card indent collapses.
9. `BUILD-JOURNAL.md` documents the atomic Phase 6 commit + manual QA steps + deferred items.
