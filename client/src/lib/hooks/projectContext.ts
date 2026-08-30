/* hooks/projectContext.ts — React Query hooks for Project Context (L05).
   Query keys: ["project-context", repoId], ["project-document", repoId, path].
   Attach mutations reuse the agent/skill key conventions from hooks/agents.ts
   and hooks/skills.ts (["agent", id] / ["agents"], ["skill", id] / ["skills"]). */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  Agent,
  DiscoveredDocument,
  DiscoverySummary,
  DocumentContent,
  SaveDocumentBody,
  SetAttachedDocsBody,
  Skill,
} from "@devdigest/shared";

export interface ProjectContextPayload {
  documents: DiscoveredDocument[];
  summary: DiscoverySummary;
}

/** Discovered project documents + discovery summary for one repo. */
export function useProjectContext(repoId: string | null | undefined) {
  return useQuery({
    queryKey: ["project-context", repoId],
    queryFn: () => api.get<ProjectContextPayload>(`/repos/${repoId}/project-context`),
    enabled: !!repoId,
  });
}

/** Full text of one discovered document (Preview/Edit). */
export function useDocument(
  repoId: string | null | undefined,
  path: string | null | undefined,
) {
  return useQuery({
    queryKey: ["project-document", repoId, path],
    queryFn: () =>
      api.get<DocumentContent>(
        `/repos/${repoId}/project-context/document?path=${encodeURIComponent(path!)}`,
      ),
    enabled: !!repoId && !!path,
  });
}

/** Save a document's text into the repo clone working tree (no git commit). */
export function useSaveDocument(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveDocumentBody) =>
      api.put<DocumentContent>(`/repos/${repoId}/project-context/document`, body),
    onSuccess: (data) => {
      qc.setQueryData(["project-document", repoId, data.path], data);
    },
  });
}

/** Replace the agent's attached docs with the FULL ordered path set. */
export function useSetAgentDocs(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paths }: SetAttachedDocsBody) =>
      api.put<Agent>(`/agents/${agentId}/attached-docs`, { paths }),
    onSuccess: (data) => {
      qc.setQueryData(["agent", data.id], data);
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

/** Replace the skill's attached docs with the FULL ordered path set. */
export function useSetSkillDocs(skillId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paths }: SetAttachedDocsBody) =>
      api.put<Skill>(`/skills/${skillId}/attached-docs`, { paths }),
    onSuccess: (data) => {
      qc.setQueryData(["skill", data.id], data);
      qc.invalidateQueries({ queryKey: ["skill", skillId] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}
