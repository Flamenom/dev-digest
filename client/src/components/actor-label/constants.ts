/** Verbs ActorLabel can prefix a name with (keys of `auth.actor.verbs`). */
export const ACTOR_VERBS = [
  "run",
  "created",
  "updated",
  "accepted",
  "dismissed",
  "authored",
  "saved",
] as const;
export type ActorVerb = (typeof ACTOR_VERBS)[number];

export const DEFAULT_LABEL_MAX_WIDTH = 240;
export const DEFAULT_AVATAR_SIZE = 22;
