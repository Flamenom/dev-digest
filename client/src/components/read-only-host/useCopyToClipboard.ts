/* useCopyToClipboard — the read-only hosts' substitute for posting (AC-43):
   write text to the clipboard and confirm with a toast (success or failure).
   Shared by FindingCard, the inline diff composer and anything else that offers
   "copy instead of post". */
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
