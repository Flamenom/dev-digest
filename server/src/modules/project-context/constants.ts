/**
 * Bucket set for project-context discovery (AC-3).
 *
 * A repo document is discoverable when it is a `.md` file living (at any
 * depth) under a directory whose name is one of these buckets — i.e.
 * `**\/{specs,docs,insights}\/**\/*.md`. The set is configuration, not an
 * inline literal, so changing it changes what discovery returns.
 */
export const BUCKETS = ['specs', 'docs', 'insights'] as const;

export type BucketName = (typeof BUCKETS)[number];
