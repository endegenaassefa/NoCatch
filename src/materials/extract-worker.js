'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path').posix;
const yauzl = require('yauzl');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { bytes, kind, limits, visualAssets } = workerData;
let decodedBytes = 0;
let assetUnavailable = false;
const visualDeadline = Date.now() + 20000;
async function retainImage(bytes, mimeType, kind) {
  if (!visualAssets || assetUnavailable || bytes.length > 2 * 1024 * 1024) return null;
  // One acknowledged image at a time bounds outstanding IPC and storage work.
  const assetId = await new Promise(resolve => {
    parentPort.once('message', message => resolve(message.assetId));
    parentPort.postMessage({ asset: { bytes, mimeType } });
  });
  if (!assetId) assetUnavailable = true;
  return assetId ? { assetId, mimeType, kind } : null;
}
function imageDimensions(bytes, type) {
  if (type === 'image/png' && bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (type !== 'image/jpeg' || bytes[0] !== 255 || bytes[1] !== 216) return [];
  for (let offset = 2; offset + 8 < bytes.length;) {
    if (bytes[offset] !== 255) return [];
    const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
    if (length < 2) return [];
    offset += length + 2;
  }
  return [];
}

function countText(text) {
  decodedBytes += Buffer.byteLength(text, 'utf8');
  if (decodedBytes > limits.maxTextBytesPerFile) throw new Error('Decoded text exceeds 4 MiB');
  return text;
}

function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      let count = 0, total = 0, done = false;
      const fail = error => { if (!done) { done = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!done) { done = true; resolve(entries); } });
      zip.on('entry', entry => {
        if (++count > limits.maxArchiveEntries || entry.generalPurposeBitFlag & 1 ||
            entry.uncompressedSize > limits.maxEntryBytes ||
            entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio ||
            total + entry.uncompressedSize > limits.maxArchiveBytes) return fail(new Error('Archive resource limit exceeded'));
        if (entries.has(entry.fileName)) return fail(new Error('Duplicate archive path'));
        if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = []; let size = 0;
          stream.on('error', fail);
          stream.on('data', chunk => {
            size += chunk.length; total += chunk.length;
            if (size > limits.maxEntryBytes || total > limits.maxArchiveBytes ||
                size / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio) {
              stream.destroy(); fail(new Error('Inflated archive resource limit exceeded')); return;
            }
            if (/\.(xml|rels)$/i.test(entry.fileName) || (visualAssets && /^ppt\/media\/.*\.(png|jpe?g)$/i.test(entry.fileName) && entry.uncompressedSize <= 2 * 1024 * 1024)) chunks.push(chunk);
          });
          stream.on('end', () => {
            if (done) return;
            entries.set(entry.fileName, /\.(xml|rels)$/i.test(entry.fileName) ? Buffer.concat(chunks).toString('utf8') : chunks.length ? Buffer.concat(chunks) : null);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false });
function xml(entries, name, required = true) {
  const text = entries.get(name);
  if (typeof text !== 'string') { if (required) throw new Error('Missing required presentation part'); return []; }
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('Unsafe or malformed XML');
  return parser.parse(text);
}
function walk(nodes, visit) {
  for (const node of nodes || []) for (const key of Object.keys(node)) {
    if (key === ':@' || key === '#text') continue;
    visit(key.split(':').pop(), node[key], node[':@'] || {});
    if (Array.isArray(node[key])) walk(node[key], visit);
  }
}
function attributesValue(attrs, name) {
  const key = Object.keys(attrs).find(key => key.replace(/^@_/, '').split(':').pop() === name);
  return attrs[key];
}
function relationships(entries, part) {
  const relfile = path.join(path.dirname(part), '_rels', path.basename(part) + '.rels');
  const result = new Map();
  walk(xml(entries, relfile, false), (tag, children, attrs) => {
    if (tag !== 'Relationship' || attributesValue(attrs, 'TargetMode') === 'External') return;
    const target = attributesValue(attrs, 'Target');
    if (typeof target !== 'string' || /[\\?#]|^[a-z]+:/i.test(target)) return;
    const normalized = target.startsWith('/') ? path.normalize(target.slice(1)) : path.normalize(path.join(path.dirname(part), target));
    if (normalized.startsWith('../') || !normalized.startsWith('ppt/')) return;
    result.set(attributesValue(attrs, 'Id'), { target: normalized, type: attributesValue(attrs, 'Type') || '' });
  });
  return result;
}
function extractText(tree) {
  const chunks = [];
  function read(nodes) {
    for (const node of nodes || []) for (const [tag, children] of Object.entries(node)) {
      const local = tag.split(':').pop();
      if (local === 't' && Array.isArray(children)) {
        for (const child of children) if (typeof child['#text'] === 'string') chunks.push(countText(child['#text']));
      } else if (Array.isArray(children)) {
        read(children);
        if (['p', 'tr'].includes(local)) chunks.push(countText('\n'));
        else if (['tc', 'br'].includes(local)) chunks.push(countText('\t'));
      }
    }
  }
  read(tree);
  return chunks.join('').trim();
}

function coverage(pages) {
  return { state: pages.some(p => p.coverage.state === 'partial') ? 'partial' : 'text', totalPages: pages.length,
    textPages: pages.filter(p => p.text).length, visualPages: pages.filter(p => p.coverage.visual).length,
    notice: 'Text extraction only. Layout, graphics, handwriting and visual meaning may be unavailable; no OCR is performed.' };
}

async function pptx() {
  const entries = await unzip(Buffer.from(bytes));
  const presentation = xml(entries, 'ppt/presentation.xml');
  const rels = relationships(entries, 'ppt/presentation.xml');
  const ordered = [];
  walk(presentation, (tag, children, attrs) => {
    if (tag !== 'sldId') return;
    const relation = rels.get(attrs['@_r:id']);
    if (!relation || !relation.type.endsWith('/slide')) throw new Error('Invalid slide relationship');
    ordered.push(relation.target);
  });
  if (!ordered.length || ordered.length > limits.maxPagesPerFile) throw new Error('Presentation page limit exceeded or no slides found');
  const pages = [], retained = new Map();
  for (const [index, part] of ordered.entries()) {
    const tree = xml(entries, part);
    const text = extractText(tree);
    let visual = false;
    walk(tree, tag => { if (['pic', 'chart', 'oleObj', 'videoFile', 'audioFile', 'relIds'].includes(tag)) visual = true; });
    let notes = '';
    for (const relationship of relationships(entries, part).values()) {
      if (relationship.type.endsWith('/notesSlide')) notes += extractText(xml(entries, relationship.target)) + '\n';
    }
    const images = [];
    if (visualAssets && !assetUnavailable && Date.now() < visualDeadline) for (const relation of relationships(entries, part).values()) {
      if (!relation.type.endsWith('/image')) continue;
      const bytes = entries.get(relation.target), mimeType = /\.png$/i.test(relation.target) ? 'image/png' : 'image/jpeg';
      if (!Buffer.isBuffer(bytes)) continue;
      try {
        const [width, height] = imageDimensions(bytes, mimeType);
        if (!width || !height || width * height > 16 * 1024 * 1024) continue;
        // Decoding validates the original bytes; never send a corrupt image.
        if (!retained.has(relation.target)) {
          await require('@napi-rs/canvas').loadImage(bytes);
          retained.set(relation.target, await retainImage(bytes, mimeType, 'embedded-image'));
        }
        const image = retained.get(relation.target);
        if (image && images.length < 4) images.push(image);
      } catch {}
    }
    pages.push({ page: index + 1, kind: 'slide', text, notes: notes.trim(), ...(images.length ? { images } : {}), coverage: {
      state: visual || !text ? 'partial' : 'text', visual, notice: visual || !text ? 'Visual content is unavailable; text and speaker notes only.' : 'Slide text and speaker notes extracted; layout is not interpreted.'
    } });
  }
  return { pages, coverage: coverage(pages) };
}

async function pdf() {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
    disableFontFace: true, useWorkerFetch: false, verbosity: 0, stopAtErrors: true, maxImageSize: visualAssets ? 16 * 1024 * 1024 : 1 });
  let document;
  try {
    document = await task.promise;
    if (!document.numPages || document.numPages > limits.maxPagesPerFile) throw new Error('PDF exceeds the page limit');
    const pages = [];
    for (let page = 1; page <= document.numPages; page++) {
      const view = await document.getPage(page);
      // Stream text so actual decoded output is bounded before building a page string.
      const reader = view.streamTextContent().getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const item of value.items) if (typeof item.str === 'string') chunks.push(countText(item.str + (item.hasEOL ? '\n' : ' ')));
      }
      const text = chunks.join('').trim();
      // Do not construct rendering operators merely to guess visual coverage.
      // Empty text may be a scan; visual meaning on all pages remains unassessed.
      const visual = !text;
      const images = [];
      if (visualAssets && !assetUnavailable && Date.now() < visualDeadline) {
        let canvas;
        try {
          const original = view.getViewport({ scale: 1 });
          const viewport = view.getViewport({ scale: Math.min(2, 1536 / Math.max(original.width, original.height)) });
          canvas = require('@napi-rs/canvas').createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await view.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
          let data = await canvas.encode('png'), mimeType = 'image/png';
          if (data.length > 2 * 1024 * 1024) { data = await canvas.encode('jpeg', 80); mimeType = 'image/jpeg'; }
          const image = await retainImage(data, mimeType, 'page-render');
          if (image) images.push(image);
        } catch {}
        finally { if (canvas) { canvas.width = 1; canvas.height = 1; } }
      }
      // maxImageSize deliberately suppresses image decoding. Consequently a
      // missing image operator is not evidence that a page has no images.
      pages.push({ page, kind: 'page', text, ...(images.length ? { images } : {}), coverage: { state: 'partial', visual,
        notice: 'Page text extracted. Image/diagram coverage is unassessed; visual meaning and OCR are unavailable.' } });
      view.cleanup();
    }
    return { pages, coverage: coverage(pages) };
  } finally { await task.destroy(); }
}

(async () => {
  try { parentPort.postMessage({ result: await (kind === 'pptx' ? pptx() : pdf()) }); }
  catch (error) { parentPort.postMessage({ error: String(error.message || 'Extraction failed').slice(0, 300) }); }
})();
