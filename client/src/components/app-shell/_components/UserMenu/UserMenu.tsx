/* UserMenu — the signed-in user's identity in the top bar (AC-32, google mode
   only): avatar, name (untrusted — rendered as text, truncated), role and a
   "Sign out" action. `useSignOut` navigates to /sign-in itself. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@devdigest/ui";
import type { CurrentSessionUser } from "@devdigest/shared";
import { ActorAvatar } from "../../../actor-label";
import { useSignOut } from "../../../../lib/hooks/session";
import { USER_AVATAR_SIZE } from "../../constants";
import { s } from "./styles";

export interface UserMenuProps {
  user: Pick<CurrentSessionUser, "name" | "email" | "avatar_url" | "role">;
}

export function UserMenu({ user }: UserMenuProps) {
  const t = useTranslations("auth");
  const tShell = useTranslations("shell");
  const signOut = useSignOut();
  const name = user.name || user.email;

  return (
    <div role="group" aria-label={t("user.menuLabel", { name })} style={s.root}>
      <ActorAvatar name={name} url={user.avatar_url} size={USER_AVATAR_SIZE} />
      <div style={s.who}>
        <span style={s.name} title={name}>
          {name}
        </span>
        <span style={s.role}>{t(`roles.${user.role}`)}</span>
      </div>
      <Button
        kind="ghost"
        size="sm"
        loading={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        {signOut.isPending ? tShell("identity.signingOut") : t("user.signOut")}
      </Button>
    </div>
  );
}

export default UserMenu;
