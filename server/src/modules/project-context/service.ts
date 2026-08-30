import type { Container } from '../../platform/container.js';
import type {
  DiscoveredDocument,
  DiscoverySummary,
  DocumentContent,
  RepoRef,
} from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { discover } from './discovery.js';
import * as documents from './documents.js';

/**
 * Project-context service. Orchestrates the per-repo document discovery
 * (discovery.ts), guarded document read/save (documents.ts), and the
 * `used_by_agents` enrichment derived from agents' attach metadata.
 *
 * Cross-module reads go through the container (`reviewRepo.getRepo` for the
 * repo row, `agentsRepo.list` for attach counts) — never a sibling module's
 * folder. Error mapping is inherited from the helpers: a missing document →
 * `NotFoundError` (404), a path-guard violation → `ValidationError` (422).
 */
export class ProjectContextService {
  constructor(private container: Container) {}

  /**
   * Resolve a repo row to its `{ owner, name }` ref, workspace-scoped: a repo
   * outside the caller's workspace is indistinguishable from a missing one
   * (404), so project docs can't be read or written across tenants.
   */
  private async resolveRepoRef(workspaceId: string, repoId: string): Promise<RepoRef> {
    const repo = await this.container.reviewRepo.getRepo(repoId);
    if (!repo || repo.workspaceId !== workspaceId) throw new NotFoundError('Repo not found');
    return { owner: repo.owner, name: repo.name };
  }

  /**
   * Discover the repo's project documents + summary, enriching each document
   * with `used_by_agents` — how many agents in the workspace have that path in
   * their `attached_doc_paths`. A missing clone dir is handled by `discover`
   * itself (empty list + `clone_available: false`), never an error.
   */
  async listForRepo(
    workspaceId: string,
    repoId: string,
  ): Promise<{ documents: DiscoveredDocument[]; summary: DiscoverySummary }> {
    const repoRef = await this.resolveRepoRef(workspaceId, repoId);
    const cloneRoot = this.container.git.clonePathFor(repoRef);
    const { documents: discovered, summary } = await discover(cloneRoot, this.container.tokenizer);
    if (discovered.length === 0) return { documents: discovered, summary };

    // used_by_agents is derived from attach metadata on the agent rows (no
    // dedicated column): count workspace agents whose ordered path list
    // contains the document's repo-relative path.
    const agents = await this.container.agentsRepo.list(workspaceId);
    const usage = new Map<string, number>();
    for (const agent of agents) {
      for (const path of agent.attachedDocPaths) {
        usage.set(path, (usage.get(path) ?? 0) + 1);
      }
    }

    return {
      documents: discovered.map((doc) => ({ ...doc, used_by_agents: usage.get(doc.path) ?? 0 })),
      summary,
    };
  }

  /** Read one document's text from the repo clone (guarded; missing → 404). */
  async readDocument(
    workspaceId: string,
    repoId: string,
    path: string,
  ): Promise<DocumentContent> {
    const repoRef = await this.resolveRepoRef(workspaceId, repoId);
    const text = await documents.readDocument(this.container.git, repoRef, path);
    return { path, text };
  }

  /**
   * Save one document's text into the repo clone working tree (guarded; NO
   * git add/commit/push). A failed write throws, so it is always reported.
   */
  async saveDocument(
    workspaceId: string,
    repoId: string,
    path: string,
    text: string,
  ): Promise<DocumentContent> {
    const repoRef = await this.resolveRepoRef(workspaceId, repoId);
    await documents.writeDocument(this.container.git, repoRef, path, text);
    return { path, text };
  }
}
