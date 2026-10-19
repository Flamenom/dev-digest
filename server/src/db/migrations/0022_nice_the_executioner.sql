CREATE INDEX "workspace_members_status_changed_by_idx" ON "workspace_members" USING btree ("status_changed_by");--> statement-breakpoint
CREATE INDEX "api_tokens_workspace_idx" ON "api_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "encrypted_secrets_updated_by_idx" ON "encrypted_secrets" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "oauth_flows_expires_at_idx" ON "oauth_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_workspace_idx" ON "sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");