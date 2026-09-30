'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const EMBEDDING = { model: 'Xenova/e5-small-v2', revision: '02af79985278377e65c724a76275707cb0333c70' };
const RERANKER = { model: 'Xenova/ms-marco-MiniLM-L-6-v2', revision: 'a09144355adeed5f58c8ed011d209bf8ee5a1fec' };
const stop = new Set('a an and are as at be been by can could did do does for from had has have how i if in into is it its of on or our should that the their them then there these they this those to was we were what when where which who why will with would you your'.split(' '));
const terms = text => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(t => t.length > 1 && !stop.has(t)))].slice(0, 48);
let embed, tokenizer, rerank, db, chunks = [], vectors = [];
let queue = Promise.resolve();
function passageInput(source) { return `passage: ${source.name.slice(0, 120)}\n${source.text}`; }

async function models(progress) {
  if (embed) return;
  progress({ state: 'loading', completed: 0, total: 0 });
  const { pipeline, AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
  env.cacheDir = workerData.cacheDir;
  env.allowLocalModels = false;
  const options = { dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } };
  embed = await pipeline('feature-extraction', EMBEDDING.model, { ...options, revision: EMBEDDING.revision });
  tokenizer = await AutoTokenizer.from_pretrained(RERANKER.model, { revision: RERANKER.revision });
  rerank = await AutoModelForSequenceClassification.from_pretrained(RERANKER.model, { ...options, revision: RERANKER.revision });
}

function passages(document, page) {
  const text = [page.text, page.notes ? `Speaker notes:\n${page.notes}` : ''].filter(Boolean).join('\n');
  const result = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 1400);
    // Tokenizer, not chars/4, enforces the embedding model's 512-token limit.
    while (embed.tokenizer.encode(passageInput({ name: document.name, text: text.slice(start, end) })).length > 480 && end > start + 1) end = start + Math.floor((end - start) / 2);
    if (embed.tokenizer.encode(passageInput({ name: document.name, text: text.slice(start, end) })).length > 480) throw new Error('A passage exceeds the embedding token limit');
    const body = text.slice(start, end);
    if (body.trim()) result.push({ id: `${document.id}:${page.kind}:${page.page}`, documentId: document.id, name: document.name, page: page.page, kind: page.kind, text: body, start });
    if (end === text.length) break;
    start = Math.max(start + 1, end - Math.min(180, Math.floor((end - start) / 5)));
  }
  return result;
}

async function build(documents, progress) {
  await models(progress);
  chunks = documents.flatMap(document => document.content.flatMap(page => passages(document, page)));
  if (chunks.length > 16000) throw new Error('This material creates too many search passages. Split it into smaller sessions.');
  db?.close(); db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE passages USING fts5(body, tokenize="porter unicode61")');
  const insert = db.prepare('INSERT INTO passages(rowid,body) VALUES (?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < chunks.length; i++) insert.run(i + 1, `${chunks[i].name}\n${chunks[i].text}`);
  db.exec('COMMIT');
  vectors = [];
  for (let i = 0; i < chunks.length; i += 8) {
    const batch = chunks.slice(i, i + 8);
    const output = await embed(batch.map(passageInput), { pooling: 'mean', normalize: true });
    for (let j = 0; j < batch.length; j++) vectors.push(Float32Array.from(output.data.subarray(j * 384, (j + 1) * 384)));
    progress({ state: 'indexing', completed: vectors.length, total: chunks.length });
  }
  return { chunks: chunks.length, embedding: EMBEDDING, reranker: RERANKER, dimensions: 384 };
}

function queries(question, history) {
  const prior = [...history].reverse().find(t => t.role === 'user' && typeof t.content === 'string')?.content || '';
  // Follow-up references carry the previous user question, never an assistant's
  // unverified answer as evidence. Longer independent questions stand alone.
  const followup = /\b(it|its|they|them|that|those|this|these|instead|also|same)\b/i.test(question) && question.length < 450;
  const query = followup && prior ? `${question}\nPrevious question: ${prior.slice(0, 900)}` : question;
  const parts = query.split(/(?<=[?;\n])\s*/).filter(p => p.trim().length > 20);
  const result = [query, ...(parts.length > 1 ? parts : [])].slice(0, 4);
  return result.map(q => {
    let text = q.slice(0, 2400);
    while (embed.tokenizer.encode(`query: ${text}`).length > 240) text = text.slice(0, Math.floor(text.length * 0.85));
    return text;
  });
}

function source(index) { const { start, ...rest } = chunks[index]; return rest; }
function fit(sources, maxChars) {
  const result = sources.map(s => ({ ...s }));
  while (result.length && JSON.stringify({ referenceMaterial: result }).length > maxChars) {
    const last = result[result.length - 1];
    const excess = JSON.stringify({ referenceMaterial: result }).length - maxChars;
    if (last.text.length > excess + 40) last.text = last.text.slice(0, last.text.length - excess);
    else result.pop();
  }
  return result;
}

async function search(question, history, maxChars) {
  if (!db) throw new Error('Material search is not prepared');
  const plan = queries(question, history), scores = new Map();
  const fuse = ranked => ranked.slice(0, 80).forEach((index, rank) => scores.set(index, (scores.get(index) || 0) + 1 / (60 + rank + 1)));
  for (const query of plan) {
    const output = await embed(`query: ${query}`, { pooling: 'mean', normalize: true });
    const dense = vectors.map((v, index) => {
      let score = 0; for (let j = 0; j < 384; j++) score += v[j] * output.data[j];
      return { index, score };
    }).sort((a, b) => b.score - a.score);
    fuse(dense.map(row => row.index));
    const words = terms(query);
    if (words.length) fuse(db.prepare('SELECT rowid FROM passages WHERE passages MATCH ? ORDER BY rank LIMIT 80').all(words.map(w => `"${w}"`).join(' OR ')).map(row => Number(row.rowid) - 1));
  }
  const candidates = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([index]) => index);
  const ranked = candidates.map(index => ({ index, score: -Infinity }));
  for (const query of plan) for (let i = 0; i < ranked.length; i += 8) {
    const batch = ranked.slice(i, i + 8);
    const inputs = tokenizer(batch.map(() => query), { text_pair: batch.map(({ index }) => `${chunks[index].name}\n${chunks[index].text}`), padding: true, truncation: true, max_length: 512 });
    const output = await rerank(inputs);
    batch.forEach((row, j) => { row.score = Math.max(row.score, Number(output.logits.data[j])); });
  }
  ranked.sort((a, b) => b.score - a.score);
  const selected = [], seen = new Set();
  for (const row of ranked) {
    // A relevance heuristic, not a probability or proof of answerability.
    if (row.score <= 0 || seen.has(chunks[row.index].id)) continue;
    selected.push(source(row.index)); seen.add(chunks[row.index].id);
    if (selected.length === 8) break;
  }
  return { sources: fit(selected, Math.min(24000, maxChars)), abstained: selected.length === 0,
    diagnostics: { candidates: candidates.map(source), rerankScores: ranked.map(r => ({ id: chunks[r.index].id, score: r.score })), queryCount: plan.length, chunks: chunks.length, embedding: EMBEDDING, reranker: RERANKER } };
}

parentPort.on('message', message => {
  queue = queue.then(async () => {
    try {
      const result = message.type === 'build'
        ? await build(message.documents, progress => parentPort.postMessage({ id: message.id, progress }))
        : await search(message.question, message.history, message.maxChars);
      parentPort.postMessage({ id: message.id, result });
    } catch (error) { parentPort.postMessage({ id: message.id, error: String(error.message || 'Local search failed').slice(0, 300) }); }
  });
});
