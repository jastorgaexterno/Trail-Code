/**
 * The `instructions` string returned in graft's MCP `initialize` response.
 *
 * This is the one piece of graft prose that survives **tool deferral**. When a
 * host has more tools than its schema budget allows, it sends tool *names* only
 * and withholds the JSONSchemas until a `ToolSearch`-style lookup fetches them —
 * measured in a real session: 111 tools deferred, of which graft's tools arrived
 * as bare strings with no descriptions at all. The MCP spec's `instructions`
 * field is delivered on a separate track (Claude Code records it as its own
 * `mcp_instructions_delta` context layer), so it lands whole even then. Other
 * servers already rely on this — `claude-in-chrome` uses it for exactly the
 * batch-your-ToolSearch instruction below; graft used to send nothing.
 *
 * Two jobs, in this order:
 *   1. Defuse the deferral tax. One lookup loads the whole tool set for the whole
 *      session, so the cost is a single round trip, not two calls per use. An
 *      agent that doesn't know this can only assume the worse reading.
 *   2. Say what each tool is FOR as a decision rule, not a feature summary —
 *      because in a host with no hooks and no skill listing (a plain chat client
 *      with an MCP config), this string plus the tool descriptions are the entire
 *      steering budget graft gets.
 *
 * Budget: keep this under ~1,000 characters. Observed sibling servers sit at
 * 660–984, and nothing proves a longer one survives un-truncated.
 */
import { brand, inBrand } from '../brand.js';

/** Tool names in the order an agent should reach for them, most-used first. */
const TOOL_ORDER = [
  'graft_find_code',
  'graft_find_all',
  'graft_trace_calls',
  'graft_file_api',
  'graft_repo_map',
  'graft_search_semantic',
  'graft_check_freshness',
  'graft_set_scope',
  'graft_build',
] as const;

/** The `select:` argument that loads every graft tool in one lookup. */
export function toolSearchQuery(prefix = `mcp__${brand()}__`): string {
  return `select:${TOOL_ORDER.map((t) => `${prefix}${inBrand(t)}`).join(',')}`;
}

/** Under trail, the same text with trail's tool names (see brand.ts `inBrand`). */
export function mcpInstructions(): string {
  return inBrand([
    'graft indexes this repo: every symbol, its file:line span and callers.',
    'Prefer these tools over grep/read.',
    '',
    `**Deferred (bare names, no schemas)? Load all in ONE lookup:** ToolSearch "${toolSearchQuery()}" — one round trip, not one call per use.`,
    '',
    '- graft_set_scope — set the session scope once',
    '- graft_find_code — where/how is X; ranked hits',
    '- graft_find_all — every occurrence',
    '- graft_trace_calls — callers, callees, blast radius',
    '- graft_file_api — a file\'s API, ~200 tokens',
    '- graft_repo_map — orient in a new repo',
    '- graft_search_semantic — natural-language search',
    '- graft_check_freshness — is the index stale?',
    '- graft_build — rebuild graph + embeddings, in background',
    '',
    'Results include uncommitted edits — the graph refreshes before each query.',
  ].join('\n'));
}
