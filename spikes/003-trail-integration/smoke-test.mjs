/**
 * Spike 003 smoke test — calls embedNodes + searchSemantic directly
 * against the graph built by `graft build` on spike 001.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');  // Trail-Code root

// --------------------------------------------------------------------------
// 1. Load the graph built by `graft build spikes/001-huggingface-transformers`
// --------------------------------------------------------------------------
// Trail stores the wiring graph at graft/.graph/wiring.json (not graph.json)
const graphPath = join(
  repoRoot,
  'spikes', '001-huggingface-transformers',
  'graft', '.graph', 'wiring.json',
);
const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
console.log(`Loaded graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
console.log('Node ids:', graph.nodes.map(n => n.id).join(', '));

// --------------------------------------------------------------------------
// 2. Import compiled semantic module
// --------------------------------------------------------------------------
const { embedNodes, searchSemantic } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'ask', 'semantic.js')).href
);

// --------------------------------------------------------------------------
// 3. Embed nodes
// --------------------------------------------------------------------------
const dbPath = join(
  repoRoot,
  'spikes', '001-huggingface-transformers',
  'graft', '.cache', 'embeddings.db',
);

console.log('\n--- embedNodes ---');
const t0 = Date.now();
await embedNodes(graph.nodes, dbPath);
console.log(`embedNodes done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// --------------------------------------------------------------------------
// 4. Semantic search: 3 queries covering the spike's content
// --------------------------------------------------------------------------
const queries = [
  'feature extraction pipeline',
  'cosine similarity calculation',
  'normalize embeddings',
];

for (const q of queries) {
  console.log(`\n--- search: "${q}" ---`);
  const hits = await searchSemantic(q, dbPath, 3);
  if (hits.length === 0) {
    console.log('  (no hits)');
  } else {
    for (const h of hits) {
      console.log(`  [${h.score}] ${h.file_path} · ${h.symbol}`);
      console.log(`        ${(h.snippet ?? '').slice(0, 80)}`);
    }
  }
}

console.log('\n✅ Smoke test complete.');
