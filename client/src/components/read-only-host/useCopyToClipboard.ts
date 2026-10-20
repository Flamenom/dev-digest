/* useCopyToClipboard — write text to the clipboard and confirm with a toast
   (success or failure). Shared by FindingCard ("Copy finding") and the inline
   diff composer ("Copy text" after a failed post, AC-32). */
"use client";

import { useTranslations } from "next-intl";
import { notify } from "@/lib/toast";

/** Returns `copy(text)` — never throws; the outcome is reported via toast. */
export function useCopyToClipboard(): (text: string) => Promise<void> {
  const t = useTranslations("prHost");
  return async (text: string) => {
    try {
      // `navigator.clipboard` is absent on insecure origins — the TypeError lands
      // in the catch and becomes the failure toast.
      await navigator.clipboard.writeText(text);
      notify.success(t("readOnly.copied"));
    } catch {
      notify.error(t("readOnly.copyFailed"));
    }
  };
}
