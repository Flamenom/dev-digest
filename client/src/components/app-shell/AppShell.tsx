/* AppShell.tsx — thin orchestrator: wires @devdigest/ui AppFrame to the command
   palette, shortcuts help, global keyboard shortcuts, and the shell context.
   All concerns live in ./hooks; overlay open/close is local view state.
   In google mode the top bar carries the signed-in user's identity
   (UserMenu); local mode keeps the shell exactly as before (AC-32). */
"use client";

import React from "react";
import { AppFrame, CommandPalette, ShortcutsHelp, type Crumb } from "@devdigest/ui";
import { useSession } from "../../lib/hooks/session";
import { useGlobalShortcuts, useShellCommands, useShellContext } from "./hooks";
import { UserMenu } from "./_components/UserMenu";

export function AppShell({ children, crumb }: { children: React.ReactNode; crumb?: Crumb[] }) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const openPalette = React.useCallback(() => setPaletteOpen(true), []);
  const closePalette = React.useCallback(() => setPaletteOpen(false), []);
  const openHelp = React.useCallback(() => setHelpOpen(true), []);
  const closeHelp = React.useCallback(() => setHelpOpen(false), []);

  useGlobalShortcuts({ onOpenPalette: openPalette, onOpenHelp: openHelp });
  const commands = useShellCommands();
  const { data: session } = useSession();
  const user = session?.mode === "google" ? session.user : null;
  const userMenu = React.useMemo(() => (user ? <UserMenu user={user} /> : undefined), [user]);
  const ctx = useShellContext({ onOpenCommandPalette: openPalette, userMenu });

  return (
    <>
      <AppFrame ctx={ctx} crumb={crumb}>
        {children}
      </AppFrame>
      <CommandPalette open={paletteOpen} commands={commands} onClose={closePalette} />
      <ShortcutsHelp open={helpOpen} onClose={closeHelp} />
    </>
  );
}
