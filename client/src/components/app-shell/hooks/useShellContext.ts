"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ShellContext } from "@devdigest/ui";
import { useTheme } from "../../../lib/theme";
import { useActiveRepo } from "../../../lib/repo-context";
import { usePulls, useDeleteRepo } from "../../../lib/hooks";
import { useCan } from "@/lib/hooks/permissions";
import { activeKeyFor, toShellRepo } from "../helpers";

interface ShellContextOptions {
  onOpenCommandPalette: () => void;
  /** Top-bar identity slot (google mode only; undefined keeps today's shell). */
  userMenu?: React.ReactNode;
}

/**
 * Assembles the `ShellContext` consumed by AppFrame: active nav key, the repo
 * list/active repo (mapped to the shell shape), theme, PR count, and the repo
 * selection / add / removal actions.
 *
 * Role gating (AC-33, UX only — the server enforces): a Member gets no
 * "remove repo" action (hidden; also hidden until the session resolves, fail
 * closed) and an inert "Add repository…" carrying the visible "Admins only"
 * reason. Local mode resolves to Admin, so nothing changes there.
 */
export function useShellContext({
  onOpenCommandPalette,
  userMenu,
}: ShellContextOptions): ShellContext {
  const t = useTranslations("shell");
  const tAuth = useTranslations("auth");
  const { isAdmin, role } = useCan();
  const isMember = role === "member";
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const { repoId, repos, activeRepo, setRepoId } = useActiveRepo();
  const { data: pulls } = usePulls(repoId);
  const deleteRepo = useDeleteRepo();

  const onSelectRepo = React.useCallback(
    (id: string) => {
      setRepoId(id);
      router.push(`/repos/${id}/pulls`);
    },
    [setRepoId, router],
  );

  const onAddRepo = React.useCallback(() => router.push("/onboarding"), [router]);

  const onRemoveRepo = React.useCallback(
    (id: string) => {
      const target = repos.find((r) => r.id === id);
      const ok = window.confirm(
        t("removeRepo.confirm", { name: target?.full_name ?? t("removeRepo.fallbackName") }),
      );
      if (!ok) return;
      deleteRepo.mutate(id, {
        onSuccess: () => {
          if (repoId === id) {
            const next = repos.find((r) => r.id !== id);
            router.push(next ? `/repos/${next.id}/pulls` : "/onboarding");
          }
        },
      });
    },
    [repos, repoId, t, deleteRepo, router],
  );

  return React.useMemo<ShellContext>(
    () => ({
      Link,
      activeKey: activeKeyFor(pathname),
      repoId,
      repos: repos.map(toShellRepo),
      activeRepo: activeRepo ? toShellRepo(activeRepo) : null,
      theme,
      onToggleTheme: toggle,
      onOpenCommandPalette,
      onSelectRepo,
      onAddRepo: isMember ? undefined : onAddRepo,
      onRemoveRepo: isAdmin ? onRemoveRepo : undefined,
      addRepoDisabledReason: isMember ? tAuth("gate.adminsOnly") : undefined,
      userMenu,
      // Sidebar badge = PRs that still NEED review, not the total PR count.
      // 0 → undefined so the badge hides entirely when nothing needs review.
      prCount: pulls?.filter((p) => p.status === "needs_review").length || undefined,
    }),
    [
      pathname,
      repoId,
      repos,
      activeRepo,
      theme,
      toggle,
      onOpenCommandPalette,
      onSelectRepo,
      onAddRepo,
      onRemoveRepo,
      pulls,
      isAdmin,
      isMember,
      tAuth,
      userMenu,
    ],
  );
}
