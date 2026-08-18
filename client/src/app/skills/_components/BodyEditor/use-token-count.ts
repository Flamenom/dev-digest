/* use-token-count.ts — live ~token estimate for the skill body editor.
   js-tiktoken's rank file is heavy, so the encoder is loaded lazily (dynamic
   import, module-level cache) and the count renders as null until it's ready. */
"use client";

import React from "react";
import type { Tiktoken } from "js-tiktoken/lite";

let encoderPromise: Promise<Tiktoken> | null = null;

function getEncoder(): Promise<Tiktoken> {
  encoderPromise ??= Promise.all([
    import("js-tiktoken/lite"),
    import("js-tiktoken/ranks/o200k_base"),
  ]).then(([{ Tiktoken }, ranks]) => new Tiktoken(ranks.default));
  return encoderPromise;
}

/** Token count of `text` (o200k_base), or null while the encoder loads. */
export function useTokenCount(text: string): number | null {
  const [encoder, setEncoder] = React.useState<Tiktoken | null>(null);

  React.useEffect(() => {
    let mounted = true;
    getEncoder()
      .then((enc) => {
        if (mounted) setEncoder(enc);
      })
      .catch(() => {
        /* counter stays hidden if the encoder fails to load */
      });
    return () => {
      mounted = false;
    };
  }, []);

  return React.useMemo(() => (encoder ? encoder.encode(text).length : null), [encoder, text]);
}
