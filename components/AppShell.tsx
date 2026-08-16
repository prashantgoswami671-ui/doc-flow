import type { ReactNode } from "react";

import TopBar from "./TopBar";

type AppShellProps = {
  children: ReactNode;
};

/**
 * Global page surface for DocFlow. Renders the TopBar and a main content
 * container. Presentation-only — it must not own PDF/document state or know
 * about individual PDF tools.
 */
export default function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <main className="flex-1">{children}</main>
    </div>
  );
}
