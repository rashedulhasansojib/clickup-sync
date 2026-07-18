/**
 * Transitional shim (v2 Phase 0). Existing callers `import { Button, Card, … } from "@/app/ui"`
 * keep working unchanged. The originals moved to `./ui-legacy` — new work should
 * import from `@/components/ui/*` (shadcn primitives) directly. When every caller
 * has migrated, delete this file + `ui-legacy.tsx` together.
 *
 * Rationale for shim-through-legacy (not shim-through-shadcn) in Phase 0:
 * - Zero visual + type regressions across `app/**`. Existing `variant="primary"`
 *   etc. keep their meaning; existing zinc-200 look stays.
 * - The spec's §4.3 example routes Button+Card through the new primitives; we
 *   defer that to Phase 1 alongside the first opt-in migration, so a page and
 *   its imports flip together.
 */
export {
  Button,
  Card,
  ErrorBanner,
  Spinner,
  PriorityBadge,
  Tag,
} from "./ui-legacy";
