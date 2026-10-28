/**
 * Spike 002: sqlite-vec on Node.js 26 Windows
 * Validates: float32 vector storage + cosine similarity via vec0 virtual table
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DIM = 384;

function randomFloat32Array(dim) {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) arr[i] = Math.random() * 2 - 1; // [-1, 1]
  return arr;
}

/** Normalize a Float32Array to unit length (required for cosine sim via dot product) */
function normalize(arr) {
  let norm = 0;
  for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / norm;
  return out;
}

console.log('=== Spike 002: sqlite-vec on Node.js 26 Windows ===\n');
console.log('Node.js:', process.version);
console.log('Platform:', process.platform, process.arch);

// 1. Open in-memory DB and load sqlite-vec extension
const db = new Database(':memory:');
sqliteVec.load(db);

// Verify sqlite-vec version (column name is the literal function call string)
const versionRow = db.prepare('SELECT vec_version()').get();
const vec_version = versionRow['vec_version()'];
console.log('\nsqlite-vec version:', vec_version);

// 2. Create virtual table with float[384] embedding + cosine distance
db.exec(`
  CREATE VIRTUAL TABLE vss_nodes
  USING vec0(embedding float[${DIM}])
`);
console.log(`\nCreated virtual table: vss_nodes (embedding float[${DIM}])`);

// 3. Insert 3 normalized fake embeddings
const insert = db.prepare('INSERT INTO vss_nodes(rowid, embedding) VALUES (?, ?)');

/** better-sqlite3 requires Buffer (blob) for typed arrays — convert Float32Array → Buffer */
function vecToBuffer(float32arr) {
  return Buffer.from(float32arr.buffer, float32arr.byteOffset, float32arr.byteLength);
}

const vectors = [];
for (let i = 1; i <= 3; i++) {
  const raw = randomFloat32Array(DIM);
  const vec = normalize(raw); // normalize for cosine similarity via L2 on unit vectors
  vectors.push(vec);
  // NOTE: rowid MUST be BigInt — JS Number fails with "Only integers are allowed" SQLITE_ERROR
  insert.run(BigInt(i), vecToBuffer(vec));
  console.log(`  Inserted row ${i}: first 5 dims = [${[...vec.slice(0, 5)].map(v => v.toFixed(4)).join(', ')}...]`);
}

// 4. Query: KNN (top 3) nearest neighbor to a random query vector
const queryRaw = randomFloat32Array(DIM);
const queryVec = normalize(queryRaw);

console.log(`\nQuery vector: first 5 dims = [${[...queryVec.slice(0, 5)].map(v => v.toFixed(4)).join(', ')}...]`);

// vec0 uses L2 distance by default; cosine distance = L2 distance on unit-norm vectors
const results = db.prepare(`
  SELECT rowid, distance
  FROM vss_nodes
  WHERE embedding MATCH ?
    AND k = 3
  ORDER BY distance
`).all(vecToBuffer(queryVec));

console.log('\n--- KNN results (L2 on unit-norm ≈ cosine distance) ---');
if (results.length === 0) {
  console.log('No results returned!');
} else {
  for (const row of results) {
    // L2 dist on unit vectors → cosine_dist = dist² / 2
    const cosineDist = (row.distance * row.distance) / 2;
    const cosineSim = 1 - cosineDist;
    console.log(`  rowid=${row.rowid}  L2_distance=${row.distance.toFixed(6)}  cosine_similarity≈${cosineSim.toFixed(6)}`);
  }
}

// 5. Extra: verify self-similarity (insert query vec itself and confirm distance~0)
insert.run(BigInt(99), vecToBuffer(queryVec));
const selfCheck = db.prepare(`
  SELECT rowid, distance
  FROM vss_nodes
  WHERE embedding MATCH ?
    AND k = 1
  ORDER BY distance
`).all(vecToBuffer(queryVec));
console.log(`\nSelf-check (query vector inserted as rowid=99, expect distance≈0):`);
console.log(`  rowid=${selfCheck[0]?.rowid}  distance=${selfCheck[0]?.distance?.toFixed(8)}`);

db.close();
console.log('\n✅ Spike completed successfully.');
