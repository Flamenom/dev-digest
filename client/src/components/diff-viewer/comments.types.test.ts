/* Type-level contract of the inline-comment post body: the client
   `CommentSubmitInput` / `CreateCommentInput` are derived from the shared
   `HostCommentInput`, and the reply fields (GitHub `in_reply_to`, GitLab
   `discussion_id`) are mutually exclusive. Checked by `pnpm typecheck`
   (tests are type-checked); the runtime assertions only keep vitest honest. */
import { describe, it, expect, expectTypeOf } from "vitest";
import type { HostCommentInput } from "@/lib/types";
import type { CreateCommentInput } from "@/lib/hooks/reviews";
import type { CommentSubmitInput } from "./comments";

describe("comment post body types", () => {
  it("derive from HostCommentInput with mutually exclusive reply fields", () => {
    const newThread: CommentSubmitInput = { path: "a.ts", line: 1, side: "RIGHT", body: "x" };
    const githubReply: CommentSubmitInput = { path: "a.ts", line: 1, side: "LEFT", body: "x", in_reply_to: 7 };
    const gitlabReply: CreateCommentInput = { path: "a.ts", line: 1, body: "x", discussion_id: "d1" };

    // @ts-expect-error — never both reply fields (the HostCommentInput refine).
    const both: CreateCommentInput = { path: "a.ts", line: 1, body: "x", in_reply_to: 7, discussion_id: "d1" };
    // @ts-expect-error — the diff viewer always knows the side.
    const noSide: CommentSubmitInput = { path: "a.ts", line: 1, body: "x" };

    // Every client post body is a valid shared HostCommentInput.
    expectTypeOf<CreateCommentInput>().toMatchTypeOf<HostCommentInput>();
    expectTypeOf<CommentSubmitInput>().toMatchTypeOf<CreateCommentInput>();
    expectTypeOf<CreateCommentInput["path"]>().toEqualTypeOf<HostCommentInput["path"]>();
    expectTypeOf<CreateCommentInput["side"]>().toEqualTypeOf<HostCommentInput["side"]>();

    expect([newThread, githubReply, gitlabReply, both, noSide]).toHaveLength(5);
  });
});
