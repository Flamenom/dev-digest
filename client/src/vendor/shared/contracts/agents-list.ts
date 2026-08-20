import { z } from 'zod';
import { Agent } from './knowledge.js';

/**
 * GET /agents list item — the frozen `Agent` DTO extended (new file, per the
 * barrel's extend-don't-edit rule) with the linked-skill count the Agents
 * list cards render.
 */
export const AgentListItem = Agent.extend({
  skill_count: z.number().int(),
});
export type AgentListItem = z.infer<typeof AgentListItem>;
