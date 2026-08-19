/* hooks/skills.ts — React Query hooks for the L02 Skills Lab (/skills).
   Query keys: ["skills"], ["skill", id], ["skills-usage"], ["skill-versions", id].
   Mutations that change skills also invalidate ["skills-usage"] (list-card and
   Stats-tab counts derive from it). */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, upload } from "../api";
import type {
  Skill,
  SkillType,
  SkillSource,
  SkillImportPreview,
  SkillUsage,
  SkillVersionEntry,
} from "@devdigest/shared";

export function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: () => api.get<Skill[]>("/skills"),
  });
}

export function useSkill(id: string | null | undefined) {
  return useQuery({
    queryKey: ["skill", id],
    queryFn: () => api.get<Skill>(`/skills/${id}`),
    enabled: !!id,
  });
}

export function useSkillsUsage() {
  return useQuery({
    queryKey: ["skills-usage"],
    queryFn: () => api.get<SkillUsage[]>("/skills/usage"),
  });
}

export function useSkillVersions(id: string | null | undefined) {
  return useQuery({
    queryKey: ["skill-versions", id],
    queryFn: () => api.get<SkillVersionEntry[]>(`/skills/${id}/versions`),
    enabled: !!id,
  });
}

export interface CreateSkillInput {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
  /** Provenance of extracted skills — the accepted conventions' evidence paths. */
  evidence_files?: string[];
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.post<Skill>("/skills", input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skills-usage"] });
      qc.setQueryData(["skill", data.id], data);
    },
  });
}

export interface UpdateSkillInput {
  id: string;
  patch: Partial<Pick<Skill, "name" | "description" | "type" | "body" | "enabled">> & {
    /** Optional one-line version note; only meaningful when `body` changes. */
    note?: string;
  };
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateSkillInput) => api.put<Skill>(`/skills/${id}`, patch),
    // Optimistic: the list-card enabled Toggle must flip instantly.
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["skills"] });
      await qc.cancelQueries({ queryKey: ["skill", id] });
      const prevList = qc.getQueryData<Skill[]>(["skills"]);
      const prevOne = qc.getQueryData<Skill>(["skill", id]);
      if (prevList) {
        qc.setQueryData<Skill[]>(
          ["skills"],
          prevList.map((sk) => (sk.id === id ? { ...sk, ...patch } : sk)),
        );
      }
      if (prevOne) qc.setQueryData<Skill>(["skill", id], { ...prevOne, ...patch });
      return { prevList, prevOne };
    },
    onError: (_e, { id }, ctx) => {
      if (ctx?.prevList) qc.setQueryData(["skills"], ctx.prevList);
      if (ctx?.prevOne) qc.setQueryData(["skill", id], ctx.prevOne);
    },
    onSuccess: (data) => {
      qc.setQueryData(["skill", data.id], data);
    },
    onSettled: (_d, _e, { id }) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skills-usage"] });
      qc.invalidateQueries({ queryKey: ["skill-versions", id] });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/skills/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skills-usage"] });
      qc.removeQueries({ queryKey: ["skill", id] });
      qc.removeQueries({ queryKey: ["skill-versions", id] });
    },
  });
}

/** Parse-only import preview (POST /skills/import, multipart `file` field).
    Persists nothing — saving happens via useCreateSkill after the user confirms. */
export function useImportSkillPreview() {
  return useMutation({
    mutationFn: (file: File) => upload<SkillImportPreview>("/skills/import", file),
  });
}
