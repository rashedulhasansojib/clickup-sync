import type { Metadata } from "next";
import "./globals.css";
import AppShell from "./AppShell";

export const metadata: Metadata = {
  title: "Meeting Analyzer",
  description: "Turn meeting transcripts into grounded, assignable tasks.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. Grammarly) inject
    // attributes like `data-gr-ext-installed` onto <body> before React hydrates,
    // which otherwise logs a benign hydration-mismatch warning. This suppresses
    // only that one-level attribute diff on <body>, nothing else.
    <html lang="en">
      <body className="min-h-screen" suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
