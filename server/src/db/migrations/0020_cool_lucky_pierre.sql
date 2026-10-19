DROP INDEX "repos_ws_provider_host_fullname_uq";--> statement-breakpoint
-- Data guards (hand-added; run BEFORE the new constraints so 0020 cannot fail on existing rows).
-- 1) Hosts were always written from lower-case constants; normalise any stray casing for repos_host_lower_ck.
UPDATE "repos" SET "host" = lower("host") WHERE "host" <> lower("host");--> statement-breakpoint
-- 2) GitLab rows were deduped case-insensitively by the app (findByIdentity: lower(full_name)), so
--    case-only duplicates should not exist. If one does (e.g. a pre-dedupe race), ABORT rather than
--    delete user data: the operator removes the duplicates manually (keep the oldest) and re-runs.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "repos" WHERE "provider" = 'gitlab'
    GROUP BY "workspace_id", "host", lower("full_name") HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'migration 0020: GitLab repos differing only by case in full_name exist; remove the duplicates manually (keep the oldest) and re-run';
  END IF;
END $$;--> statement-breakpoint
-- 3) change_type / patch_omitted are informational; readers already drop unknown values
--    (detail-service safeParse), so NULLing anything outside the allowed set preserves behaviour.
UPDATE "pr_files" SET "change_type" = NULL
WHERE "change_type" IS NOT NULL AND "change_type" NOT IN ('added', 'modified', 'deleted', 'renamed');--> statement-breakpoint
UPDATE "pr_files" SET "patch_omitted" = NULL
WHERE "patch_omitted" IS NOT NULL AND "patch_omitted" NOT IN ('too_large', 'collapsed');--> statement-breakpoint
CREATE UNIQUE INDEX "repos_gitlab_ws_host_lower_fullname_uq" ON "repos" USING btree ("workspace_id","provider","host",lower("full_name")) WHERE "repos"."provider" = 'gitlab';--> statement-breakpoint
CREATE UNIQUE INDEX "repos_ws_provider_host_fullname_uq" ON "repos" USING btree ("workspace_id","provider","host","full_name") WHERE "repos"."provider" <> 'gitlab';--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_host_lower_ck" CHECK ("repos"."host" = lower("repos"."host"));--> statement-breakpoint
ALTER TABLE "pr_files" ADD CONSTRAINT "pr_files_change_type_ck" CHECK ("pr_files"."change_type" in ('added', 'modified', 'deleted', 'renamed'));--> statement-breakpoint
ALTER TABLE "pr_files" ADD CONSTRAINT "pr_files_patch_omitted_ck" CHECK ("pr_files"."patch_omitted" in ('too_large', 'collapsed'));