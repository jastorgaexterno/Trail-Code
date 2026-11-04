/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; diagnostics go to stderr.
 * Cloud/workspace connector removed (trail-solo-grafo change).
 */
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { TOOLS, callTool } from './tools.js';
import { mcpInstructions } from './instructions.js';
import { hasGraftIndex } from '../graph/root.js';
import { mainWorktreeRoot } from '../graph/seed.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { maybeFlushInBackground, track } from '../telemetry/index.js';
import { brand, inBrand } from '../brand.js';
import { canonicalToolName, GRAFT_MCP_TOOL_NAMES } from './tool-names.js';

const TOOL_COMMAND: Record<string, string> = {
  graft_find_code: 'ask',
  graft_find_all: 'grep',
  graft_trace_calls: 'callers',
  graft_file_api: 'skeleton',
  graft_repo_map: 'map',
  graft_check_freshness: 'check',
};

function isRepoTool(name: string): boolean {
  return GRAFT_MCP_TOOL_NAMES.has(name.toLowerCase()) || GRAFT_MCP_TOOL_NAMES.has(canonicalToolName(name).toLowerCase());
}

function send(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id: unknown, result: object): void { send({ jsonrpc: '2.0', id, result }); }
function replyError(id: unknown, code: number, message: string): void { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function advertised(root: string, dirOverride?: string): typeof TOOLS {
  if (dirOverride !== undefined) return TOOLS;
  if (hasGraftIndex(root)) return TOOLS;
  const main = mainWorktreeRoot(root);
  return main && hasGraftIndex(main) ? TOOLS : [];
}

export function startMcpServer(root: string, dirOverride?: string, version = '0', opts: { brainsOnly?: boolean } = {}): void {
  const brainsOnly = opts.brainsOnly === true;
  const upkeep = brainsOnly ? [] : runUpkeep(root, runningVersion()).lines;
  for (const line of upkeep) console.error(line);
  if (!brainsOnly) maybeFlushInBackground();

  const repoTools = () =>
    (brainsOnly ? [] : advertised(root, dirOverride)).map((t) => ({ name: inBrand(t.name), description: inBrand(t.description), inputSchema: t.inputSchema }));

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let clientRoot: string | null = null;
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, any> };
    try { msg = JSON.parse(text); } catch { replyError(null, -32700, 'parse error'); return; }
    const { id, method, params } = msg;
    const isNotification = id === undefined;
    switch (method) {
      case 'initialize': {
        const roots = params?.roots as Array<{ uri?: string }> | undefined;
        if (roots?.[0]?.uri) {
          try { clientRoot = fileURLToPath(roots[0].uri); process.stderr.write(`[trail-scope] clientRoot from roots: ${clientRoot}\n`); } catch { /* non-file URI */ }
        }
        const local = [upkeep.length ? upkeep.join('\n') : '', brainsOnly ? '' : mcpInstructions()];
        reply(id, { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: brand(), version }, instructions: local.filter(Boolean).join('\n\n') });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list':
        if (isNotification) return;
        reply(id, { tools: repoTools() });
        return;
      case 'prompts/list':
        if (isNotification) return;
        reply(id, { prompts: [] });
        return;
      case 'prompts/get':
        if (isNotification) return;
        replyError(id, -32601, 'no prompts available');
        return;
      case 'tools/call': {
        if (isNotification) return;
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (brainsOnly && !isRepoTool(name)) {
          reply(id, { content: [{ type: 'text', text: `this server answers local graph tools only; ${name} isn't one` }], isError: true });
          return;
        }
        if (canonicalToolName(name) === 'trail_set_scope') {
          const p = String(args['path'] ?? '').replace(/\\/g, '/').replace(/\/$/, '');
          const srv = root.replace(/\\/g, '/').replace(/\/$/, '');
          if (p.startsWith(srv + '/')) {
            clientRoot = String(args['path'] ?? '');
            reply(id, { content: [{ type: 'text', text: `scope set to: ${p.slice(srv.length + 1)} — all queries will narrow to this path automatically` }], isError: false });
          } else {
            reply(id, { content: [{ type: 'text', text: `path "${p}" is not under the server workspace "${srv}" — scope unchanged` }], isError: true });
          }
          return;
        }
        const argsWithScope = injectClientScope(args, root, clientRoot);
        callTool(root, name, argsWithScope, dirOverride).then(
          (r) => {
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

function injectClientScope(args: Record<string, unknown>, serverRoot: string, clientRoot: string | null): Record<string, unknown> {
  if (args['in'] != null || !clientRoot) return args;
  const server = serverRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const client = clientRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (!client.startsWith(server + '/') || client === server) return args;
  return { ...args, in: client.slice(server.length + 1) };
}
