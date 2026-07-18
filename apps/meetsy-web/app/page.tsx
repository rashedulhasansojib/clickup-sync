"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/app/ui";

/**
 * `/` used to render the upload form; that moved to `/new` in v2 Phase 1.
 * The landing page for signed-in users is now `/home`. Client-side redirect
 * (not a server redirect) because the AppShell auth gate runs client-side and
 * a hard redirect would race the KB gate.
 */
export default function RootRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/home");
  }, [router]);
  return (
    <div className="flex justify-center py-20">
      <Spinner label="Loading…" />
    </div>
  );
}
