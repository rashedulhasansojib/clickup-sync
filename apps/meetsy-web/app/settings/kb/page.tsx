import { redirect } from "next/navigation";

/**
 * v2 Phase 4 — `/settings/kb` was folded into the consolidated `/kb` route.
 * External bookmarks land on the Rebuild tab.
 */
export default function KbSettingsRedirect(): never {
  redirect("/kb?tab=rebuild");
}
