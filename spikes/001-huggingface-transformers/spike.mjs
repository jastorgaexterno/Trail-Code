// Spike 001: @huggingface/transformers on Node.js 26 Windows — pure ONNX embeddings
import { pipeline } from '@huggingface/transformers';

// ---------------------------------------------------------------------------
// 3 code-snippet inputs: two relate to auth/session, one to credit/finance
// ---------------------------------------------------------------------------
const snippets = [
  // Snippet 1: credit/finance domain
  `function calcularAlternativasCredito(monto, plazo, tasaInteres) {
    const cuota = (monto * tasaInteres) / (1 - Math.pow(1 + tasaInteres, -plazo));
    return { cuota, totalPagar: cuota * plazo, interesTotal: cuota * plazo - monto };
  }`,

  // Snippet 2: network error handling
  `async function fetchWithRetry(url, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
        return await response.json();
      } catch (err) {
        if (attempt === maxRetries - 1) throw err;
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }`,

  // Snippet 3: user auth / session (should be closer to snippet 2 via general programming)
  // Actually let's reconsider: snippet 1 (credit) vs snippet 3 (auth) are both domain logic
  // The task says 1&3 should be higher — both relate to auth/session concepts... wait,
  // re-reading: snippet 1 = credit, snippet 2 = error handling, snippet 3 = auth.
  // "1&3 should be higher since both relate to auth/session" — that can't be right for credit vs auth.
  // The task says compare sim(1,2) vs sim(1,3). Snippet 1 is credit, 3 is auth.
  // Actually the task says sim(1,3) should be HIGHER than sim(1,2)... hmm.
  // Rethinking: maybe they're 0=credit, 1=error, 2=auth, and (0,1) vs (0,2)?
  // Let me just run it and report honestly. The model decides.
  `class SessionManager {
    constructor(store) { this.store = store; }
    async authenticate(token) {
      const session = await this.store.get(token);
      if (!session || Date.now() > session.expiresAt) throw new Error('Unauthorized');
      return session.userId;
    }
    async invalidate(token) { await this.store.delete(token); }
  }`,
];

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('=== Spike 001: @huggingface/transformers on Node.js 26 Windows ===\n');
console.log('Loading pipeline (first run downloads model ~23MB)...');

const extractor = await pipeline(
  'feature-extraction',
  'Xenova/all-MiniLM-L6-v2',
  { dtype: 'fp32' }
);

console.log('Pipeline loaded.\n');

const labels = ['credit/finance', 'network error-handling', 'user auth/session'];
const tensors = [];

for (let i = 0; i < snippets.length; i++) {
  const output = await extractor(snippets[i], { pooling: 'mean', normalize: true });
  const vec = Array.from(output.data);
  tensors.push(vec);

  console.log(`--- Snippet ${i + 1}: "${labels[i]}" ---`);
  console.log(`  Vector length : ${vec.length}`);
  console.log(`  dtype         : float32 (JS Float32Array via .data)`);
  console.log(`  First 5 values: [${vec.slice(0, 5).map(v => v.toFixed(6)).join(', ')}]`);
  console.log();
}

const sim12 = cosineSimilarity(tensors[0], tensors[1]);
const sim13 = cosineSimilarity(tensors[0], tensors[2]);
const sim23 = cosineSimilarity(tensors[1], tensors[2]);

console.log('=== Cosine Similarities ===');
console.log(`  sim(snippet1, snippet2)  credit  vs network-error : ${sim12.toFixed(6)}`);
console.log(`  sim(snippet1, snippet3)  credit  vs auth/session   : ${sim13.toFixed(6)}`);
console.log(`  sim(snippet2, snippet3)  network vs auth/session   : ${sim23.toFixed(6)}`);
console.log();
console.log(`  Most similar pair: ${sim23 >= sim12 && sim23 >= sim13 ? 'snippet2 & snippet3 (network vs auth — both async programming patterns)' : sim12 >= sim13 ? 'snippet1 & snippet2' : 'snippet1 & snippet3'}`);
console.log();
console.log('=== DONE ===');
