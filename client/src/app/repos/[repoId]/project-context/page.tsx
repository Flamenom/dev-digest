/* Route: /repos/:repoId/project-context — Project Context (L05). Server
   Component shell (Next 15: params is a Promise); all interactivity lives in
   the "use client" ProjectContextView. */
import { ProjectContextView } from "./_components/ProjectContextView";

export default async function ProjectContextPage({
  params,
}: {
  params: Promise<{ repoId: string }>;
}) {
  const { repoId } = await params;
  return <ProjectContextView repoId={repoId} />;
}
