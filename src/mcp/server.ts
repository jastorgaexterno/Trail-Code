/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool } from './tools.js';
import { mcpInstructions } from './instructions.js';
import { hasGraftIndex } from '../graph/root.js';
import { mainWorktreeRoot } from '../graph/seed.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { maybeFlushInBackground, track } from '../telemetry/index.js';
import { brand, inBrand } from '../brand.js';
import { canonicalToolName } from './tool-names.js';
import { GRAFT_MCP_TOOL_NAMES } from './tool-names.js';
import { WorkspaceConnector, type RemotePrompt, type RemoteTool } from './connector.js';

/**
 * MCP tool name → the command enum the telemetry contract knows. A tool absent
 * here is simply not counted: `track` would drop an unlisted command anyway, and
 * mapping by hand keeps the wire vocabulary identical across the CLI and MCP so
 * `ask` means the same thing in both.
 */
const TOOL_COMMAND: Record<string, string> = {
  graft_find_code: 'ask',
  graft_find_all: 'grep',
  graft_trace_calls: 'callers',
  graft_file_api: 'skeleton',
  graft_repo_map: 'map',
  graft_check_freshness: 'check',
};

/**
 * How long the client waits on the workspace (for `initialize`'s
 * instructions, for `tools/list` and `prompts/list`) before trail answers
 * with what it has: a slow cloud never holds the repo tools up for long.
 */
const WORKSPACE_WAIT_MS = 4000;

/** What the workspace-only server says when this machine isn't paired (any more). */
const NOT_CONNECTED_LINE = 'Not connected to a Trail workspace: run `trail init --connect <code>` with the code from team.trailhq.com to use its learnings and skills here.';

/** Said when paired but the workspace didn't answer in time. */
const UNREACHABLE_LINE = "Your Trail workspace didn't answer when this session started, so its learnings and skills may be missing here.";

/** `p`, or `fallback` once `ms` have passed. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<{ value: T; late: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ value: fallback, late: true }), ms);
    timer.unref();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value, late: false });
      },
      () => {
        clearTimeout(timer);
        resolve({ value: fallback, late: false });
      },
    );
  });
}

/** Whether a tool name is one of the repo's own (graft_*, trail_* and their old names). */
function isRepoTool(name: string): boolean {
  return GRAFT_MCP_TOOL_NAMES.has(name.toLowerCase());
}

function send(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: unknown, result: object): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Which tools this server admits to having.
 *
 * `hosts/claude-global.ts` registers graft at the *user* MCP scope, which starts this
 * server in every project the user opens — including ones that never asked for graft.
 * Six tool schemas is real context, charged on every turn of every session, and in a
 * repo with no graph every one of them can only answer "run graft build". So a repo
 * that never invited graft is told there is nothing to call.
 *
 * The parent-checkout clause is not an optimization, it is the case the global
 * registration exists for: a fresh `git worktree add` has no `graft/` of its own
 * (it's gitignored, so git never checks it out) and gets one from its parent on the
 * first query — see graph/seed.ts. Gating on this tree alone would hide graft in
 * precisely the worktree the user is trying to work in, which is the bug, inverted.
 *
 * A `--dir` override is an explicit "the graph is over there", so it always
 * advertises without a probe.
 */
function advertised(root: string, dirOverride?: string): typeof TOOLS {
  if (dirOverride !== undefined) return TOOLS;
  if (hasGraftIndex(root)) return TOOLS;
  const main = mainWorktreeRoot(root);
  return main && hasGraftIndex(main) ? TOOLS : [];
}

/**
 * `version` is threaded in from the CLI rather than read here: `readCurrentVersion`
 * resolves package.json relative to the calling module, and from `dist/mcp/` that
 * lookup misses. The caller already knows it.
 */
export function startMcpServer(root: string, dirOverride?: string, version = '0', opts: { brainsOnly?: boolean } = {}): void {
  // `trail mcp --brains`: the one entry Claude Code gets once paired with a
  // workspace. It serves the workspace's tools and prompts and nothing of the
  // repo's, so it does none of the repo upkeep either: it starts in every
  // project. (The flag keeps its old name: entries already written use it.)
  const brainsOnly = opts.brainsOnly === true;
  // The self-maintenance pass, run once at boot. This is the ONLY channel that
  // reaches hosts with no hook support (Cursor, and any plain MCP client): it
  // refreshes rule files an older `graft init` wrote, and kicks off the cached
  // registry check. Both are fail-soft, and the resulting lines ride along in
  // `instructions` below — stdout is protocol-only, so there is nowhere else to
  // put them. Never blocks: the registry fetch happens in a detached child.
  const upkeep = brainsOnly ? [] : runUpkeep(root, runningVersion()).lines;
  for (const line of upkeep) console.error(line);
  // Same deal for the telemetry queue: flushed from a detached child at boot, so
  // a Cursor user who never touches the CLI still gets their events out.
  //
  // Deliberately NOT the first-run notice. This server's stderr goes to an editor
  // log nobody reads, so printing it here would mark the disclosure as shown
  // without anyone having seen it. It stays pending for the next CLI command,
  // and `graft init`'s picker is the channel that reached this user already.
  if (!brainsOnly) maybeFlushInBackground();

  // The workspace's own MCP server, when this machine is paired with one:
  // started now, so its instructions are in hand by the time the client asks.
  const workspace = new WorkspaceConnector({ version });
  workspace.warm();

  /** The repo's tools this server lists, under trail as `trail_*` in trail's words. */
  const repoTools = () =>
    (brainsOnly ? [] : advertised(root, dirOverride)).map((t) => ({ name: inBrand(t.name), description: inBrand(t.description), inputSchema: t.inputSchema }));

  /**
   * A listing from the workspace, waited on for WORKSPACE_WAIT_MS at most.
   * One that comes in after the client got its answer is announced with
   * `list_changed`, once, so the client asks again and gets it.
   */
  const announced = new Set<string>();
  async function fromWorkspace<T>(list: () => Promise<T[] | null>, changed: string): Promise<T[]> {
    const pending = list();
    const { value, late } = await within(pending, WORKSPACE_WAIT_MS, null);
    if (late && !announced.has(changed)) {
      announced.add(changed);
      pending.then((v) => v && v.length > 0 && send({ jsonrpc: '2.0', method: changed }), () => {});
    }
    return value ?? [];
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, any> };
    try {
      msg = JSON.parse(text);
    } catch {
      replyError(null, -32700, 'parse error');
      return;
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined;
    const paired = workspace.connected();
    switch (method) {
      case 'initialize': {
        const local = [upkeep.length ? upkeep.join('\n') : '', brainsOnly ? '' : mcpInstructions()];
        const answer = (remote: string[]) =>
          reply(id, {
            protocolVersion: params?.protocolVersion ?? '2024-11-05',
            // Paired: the workspace's prompts too, and lists that can change once it answers.
            capabilities: paired ? { tools: { listChanged: true }, prompts: { listChanged: true } } : { tools: {} },
            serverInfo: { name: brand(), version },
            // The one channel that survives tool deferral — see ./instructions.ts.
            // The workspace's own instructions follow the repo's.
            instructions: [...local, ...remote].filter(Boolean).join('\n\n'),
          });
        if (!paired) {
          answer([brainsOnly ? NOT_CONNECTED_LINE : '']);
          return;
        }
        within(workspace.instructions(), WORKSPACE_WAIT_MS, '').then(({ value }) => answer([value || UNREACHABLE_LINE]));
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications get no response
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list': {
        if (isNotification) return;
        const local = repoTools();
        if (!paired) {
          reply(id, { tools: local });
          return;
        }
        // Paired: the workspace's tools too, as it defines them. A repo tool's name wins a clash.
        const taken = new Set(local.map((t) => t.name));
        fromWorkspace<RemoteTool>(() => workspace.listTools(), 'notifications/tools/list_changed').then((remote) =>
          reply(id, { tools: [...local, ...remote.filter((t) => !taken.has(t.name))] }),
        );
        return;
      }
      case 'prompts/list': {
        if (isNotification) return;
        if (!paired) {
          reply(id, { prompts: [] });
          return;
        }
        fromWorkspace<RemotePrompt>(() => workspace.listPrompts(), 'notifications/prompts/list_changed').then((prompts) => reply(id, { prompts }));
        return;
      }
      case 'prompts/get': {
        if (isNotification) return;
        // Every prompt is the workspace's: the repo serves none. Never throws.
        workspace.getPrompt(String(params?.name ?? ''), (params?.arguments ?? {}) as Record<string, unknown>).then((r) =>
          'result' in r ? reply(id, r.result as object) : replyError(id, r.error.code, r.error.message),
        );
        return;
      }
      case 'tools/call': {
        if (isNotification) return;
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (!isRepoTool(name) && (paired || brainsOnly)) {
          // The workspace's: passed to it as is. Never throws.
          workspace.callTool(name, args).then((r) => reply(id, r));
          return;
        }
        if (brainsOnly) {
          reply(id, { content: [{ type: 'text', text: `this server answers your Trail workspace's tools only; ${name} isn't one` }], isError: true });
          return;
        }
        // Async because a tool call may rebuild the graph first (see
        // graph/refresh.ts). `callTool` absorbs its own errors, so the only thing
        // that can reject here is a bug — surface it as a JSON-RPC error rather
        // than an unhandled rejection that kills the server.
        callTool(root, name, args, dirOverride).then(
          (r) => {
            // No `hit`: `isError` means the tool failed, which is not the same
            // question as "did the graph have an answer". Absent beats wrong.
            // hasOwn for the same reason as track()'s: a client is free to send
            // `{"name":"constructor"}`, and a plain lookup would hand `track` a
            // function rather than undefined.
            const canonical = canonicalToolName(name);
            const command = Object.hasOwn(TOOL_COMMAND, canonical) ? TOOL_COMMAND[canonical] : undefined;
            track('query', { command, surface: 'mcp' }, { repo: root, host: 'mcp' });
            reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
          },
          (err) => replyError(id, -32603, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
