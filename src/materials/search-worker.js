'use strict';
const { DatabaseSync } = require('node:sqlite');
let limits, cacheDir;
const send = message => { if (process.connected) process.send(message, () => {}); };
process.on('disconnect', () => process.exit(0));
const MODEL = 'Xenova/e5-small-v2', REVISION = '02af79985278377e65c724a76275707cb0333c70';
const stop = new Set('a an and are as at be been by can could did do does for from had has have how i if in into is it its of on or our should that the their them then there these they this those to was we were what when where which who why will with would you your'.split(' '));
const words = text => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 1 && !stop.has(w)))];
let pages = [], chunks = [], vectors = [], embed, db, prepared;
let queue = Promise.resolve();
const cancelled = new Set(), pendingIds = new Set();
const envelope = sources => JSON.stringify({ referenceMaterial: sources }).length;
const passage = chunk => `passage: ${chunk.name.slice(0, 120)}\n${chunk.text}`;

async function model() {
  if (embed) return;
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  env.allowLocalModels = false;
  embed = await pipeline('feature-extraction', MODEL, { revision: REVISION, dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
}
function split(source) {
  const result = [];
  for (let start = 0; start < source.text.length;) {
    let end = Math.min(source.text.length, start + 1400);
    if (embed) while (embed.tokenizer.encode(passage({ ...source, text: source.text.slice(start, end) })).length > 480 && end > start + 1) end = start + Math.floor((end - start) / 2);
    if (source.text.slice(start, end).trim()) result.push({ ...source, text: source.text.slice(start, end), start, end });
    if (end === source.text.length) break;
    start = Math.max(start + 1, end - Math.min(180, Math.floor((end - start) / 5)));
  }
  return result;
}
async function build(documents, progress) {
  pages = documents.flatMap(document => document.content.map(page => ({ id: `${document.id}:${page.kind}:${page.page}`, documentId: document.id,
    name: document.name, page: page.page, kind: page.kind,
    text: [page.text, page.notes ? `Speaker notes:\n${page.notes}` : '', !page.text && !page.notes && page.images?.length ? 'This page has an image but no extracted text. Its visual content must be inspected; do not infer its contents from this placeholder.' : ''].filter(Boolean).join('\n') })).filter(page => page.text.trim()));
  const allFit = pages.length <= limits.maxSources && envelope(pages) <= limits.maxContextChars;
  let semantic = false;
  if (!allFit) {
    progress({ state: 'loading-model', completed: 0, total: pages.length });
    try { await model(); semantic = true; } catch {}
  }
  chunks = pages.flatMap(split);
  if (chunks.length > limits.maxSearchChunks) throw new Error('Material exceeds the search passage limit.');
  db?.close(); db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE passages USING fts5(body, tokenize="porter unicode61")');
  const insert = db.prepare('INSERT INTO passages(rowid,body) VALUES (?,?)');
  db.exec('BEGIN');
  chunks.forEach((chunk, i) => insert.run(i + 1, `${chunk.name}\n${chunk.text}`));
  db.exec('COMMIT');
  vectors = [];
  if (semantic) for (let i = 0; i < chunks.length; i += 8) {
    const batch = chunks.slice(i, i + 8);
    const result = await embed(batch.map(passage), { pooling: 'mean', normalize: true });
    for (let j = 0; j < batch.length; j++) vectors.push(Float32Array.from(result.data.subarray(j * 384, (j + 1) * 384)));
    progress({ state: 'indexing', completed: Math.min(i + 8, chunks.length), total: chunks.length });
  }
  prepared = { strategy: allFit ? 'full-context' : semantic ? 'hybrid' : 'lexical-fallback', indexedChunks: chunks.length,
    embeddingModel: semantic ? MODEL : null, embeddingRevision: semantic ? REVISION : null, dimensions: semantic ? 384 : 0 };
  return prepared;
}
function plan(question, history) {
  const previous = [...history].reverse().find(turn => turn.role === 'user' && typeof turn.content === 'string')?.content;
  const followup = question.length < 450 && /\b(it|its|they|them|that|those|this|these|instead|also|same|he|she)\b/i.test(question);
  const text = followup && previous ? `${question}\nPrevious question: ${previous.slice(-1200)}` : question;
  const pieces = [text.slice(0, 2200)];
  if (text.length > 2200) pieces.push(text.slice(-2200));
  const clauses = text.split(/[?;\n]/).filter(p => p.trim().length > 20);
  if (clauses.length > 1) pieces.push(...clauses);
  return [...new Set(pieces)].slice(0, 4);
}
async function search(question, history, maxChars, strategy, id) {
  if (!prepared) throw new Error('Materials are not prepared.');
  maxChars = Math.min(limits.maxContextChars, Math.max(0, maxChars));
  if (strategy !== 'hybrid' && pages.length <= limits.maxSources && envelope(pages) <= maxChars) {
    return { strategy: 'full-context', sources: pages, diagnostics: { ...prepared, candidateCount: pages.length } };
  }
  const queries = plan(question, history), scores = new Map();
  const fuse = ranked => ranked.slice(0, 80).forEach((index, rank) => scores.set(index, (scores.get(index) || 0) + 1 / (60 + rank + 1)));
  for (const query of queries) {
    if (cancelled.has(id)) return null;
    if (vectors.length) {
      let input = query;
      while (embed.tokenizer.encode(`query: ${input}`).length > 480) input = input.slice(0, Math.floor(input.length * .8));
      const vector = await embed(`query: ${input}`, { pooling: 'mean', normalize: true });
      const dense = vectors.map((v, index) => { let score = 0; for (let j = 0; j < 384; j++) score += v[j] * vector.data[j]; return { index, score }; }).sort((a,b) => b.score - a.score);
      fuse(dense.map(row => row.index));
    }
    const terms = words(query).slice(0, 128);
    if (terms.length) fuse(db.prepare('SELECT rowid FROM passages WHERE passages MATCH ? ORDER BY rank LIMIT 80').all(terms.map(w => `"${w}"`).join(' OR ')).map(row => Number(row.rowid) - 1));
  }
  const ranked = [...scores].sort((a,b) => b[1] - a[1]).map(([index]) => index);
  // Explicit source/page requests are a deterministic scope, independent of
  // model similarity. Preserve neighbouring evidence without a reranker cutoff.
  const normalized = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const queryName = normalized(question);
  const named = new Set(pages.filter(page => queryName.includes(normalized(page.name.replace(/\.(pdf|pptx)$/i, '')))).map(page => page.documentId));
  const requested = [...question.matchAll(/\b(?:slide|page|p\.)\s*(\d{1,4})\b/gi)].map(m => Number(m[1]));
  const explicit = chunks.map((chunk, index) => ({ chunk, index })).filter(({chunk}) => requested.includes(chunk.page) && (!named.size || named.has(chunk.documentId))).map(row => row.index);
  const candidates = [...new Set([...explicit, ...ranked])].slice(0, 32);
  const ordered = [...candidates];
  for (const index of candidates.slice(0, 12)) for (const neighbour of [index - 1, index + 1]) {
    if (chunks[neighbour]?.documentId === chunks[index].documentId && Math.abs(chunks[neighbour].page - chunks[index].page) <= 1) ordered.push(neighbour);
  }
  const sources = [], seenChunks = new Set();
  for (const index of ordered) {
    if (seenChunks.has(index)) continue;
    seenChunks.add(index);
    const { start, end, ...source } = chunks[index];
    const existing = sources.find(s => s.id === source.id);
    if (existing) {
      if (!existing.text.includes(source.text)) {
        const extended = `${existing.text}\n[…]\n${source.text}`;
        const old = existing.text; existing.text = extended;
        if (envelope(sources) > maxChars) existing.text = old;
      }
    } else if (sources.length < limits.maxSources && envelope([...sources, source]) <= maxChars) sources.push(source);
  }
  return { strategy: vectors.length ? 'hybrid' : 'lexical-fallback', sources,
    diagnostics: { ...prepared, candidateCount: candidates.length, queryCount: queries.length } };
}
process.on('message', message => {
  if (message.type === 'cancel') { if (pendingIds.has(message.id)) cancelled.add(message.id); return; }
  // Detached callers must not turn one slow inference into an unbounded queue.
  // Canceled entries remain bounded until their turn is skipped and released.
  if (pendingIds.size >= 6) { send({ id: message.id, error: 'Local material search is busy.' }); return; }
  pendingIds.add(message.id);
  queue = queue.then(async () => {
    try {
      if (cancelled.has(message.id)) return;
      if (message.type === 'build') ({ limits, cacheDir } = message.settings);
      const result = message.type === 'build'
        ? await build(message.documents, progress => send({ id: message.id, progress }))
        : await search(message.question, message.history, message.maxChars, message.strategy, message.id);
      if (!cancelled.has(message.id)) send({ id: message.id, result });
    } catch { send({ id: message.id, error: 'Local material search is unavailable.' }); }
    finally { cancelled.delete(message.id); pendingIds.delete(message.id); }
  });
});
