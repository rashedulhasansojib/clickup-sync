import type { Metadata } from "next";
import "./globals.css";
import AppShell from "./AppShell";
import { ThemeProvider } from "@/components/theme-provider";

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
    // suppressHydrationWarning on <html> is required by next-themes (which
    // writes the theme class onto <html> before hydration). suppressHydrationWarning
    // on <body> continues to swallow the Grammarly `data-gr-ext-installed`
    // attribute diff (browser extensions inject attributes onto <body> before
    // React hydrates). Both are one-level attribute diffs only, not tree diffs.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen" suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
