/* ActorAvatar — a Google profile photo when the URL is on the allowlist
   (`https://*.googleusercontent.com`), otherwise the design-system initials
   avatar. Decorative: the name is always rendered as text next to it. */
"use client";

import React from "react";
import { Avatar } from "@devdigest/ui";
import { isSafeAvatarUrl } from "./helpers";
import { DEFAULT_AVATAR_SIZE } from "./constants";
import { s } from "./styles";

export interface ActorAvatarProps {
  name: string;
  url?: string | null;
  size?: number;
}

export function ActorAvatar({ name, url, size = DEFAULT_AVATAR_SIZE }: ActorAvatarProps) {
  // Remember WHICH url failed, so a new url gets a fresh attempt.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  if (!isSafeAvatarUrl(url) || failedUrl === url) return <Avatar name={name || "?"} size={size} />;
  return (
    // A tiny remote profile photo: next/image's optimizer adds nothing here and
    // would need a remotePatterns entry; the URL is allowlisted above.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      style={s.avatarImg(size)}
      onError={() => setFailedUrl(url)}
    />
  );
}

export default ActorAvatar;
