require('dotenv').config();

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '1mb' }));
const PORT = process.env.PORT || 3000;

const MODEL = 'gemini-3.1-flash-image-preview';

// Where saved sessions live. On Railway, sessions MUST be written inside the
// attached Volume or they are wiped on every redeploy. Railway injects
// RAILWAY_VOLUME_MOUNT_PATH (the Volume's mount path, e.g. /app/data), so we
// write into it directly rather than guessing the path. Locally we fall back to
// a ./data folder in the project.
const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sessions')
    : path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('Frame Factory storing sessions in:', DATA_DIR);

const STYLE_ANCHOR =
  'Lo-fi 2D doodle illustration. Plain white background only. Thick black hand-drawn outlines. ' +
  'Flat colour fills only, no gradients, no shading. Stick figure characters with circular peach heads, ' +
  'small dot eyes, single curved line mouth. Simple and minimal — draw less not more. ' +
  'Match the reference character exactly: same head size, same line weight, same proportions. ' +
  'ASPECT RATIO: 16:9 widescreen landscape format. The image must be wider than it is tall. ' +
  'Leave generous white space on either side of characters.';

// Delay between API calls to avoid rate limiting.
const API_DELAY_MS = 2000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

// Live run state per session (only while generating). For SSE + API key.
const live = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- validation helpers (guard against path traversal) ----
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMG_RE = /^\d{6}\.png$/;
const REF_RE = /^ref\d+\.png$/;
const validId = (id) => ID_RE.test(id || '');

// ---- paths ----
const sessionDir = (id) => path.join(DATA_DIR, id);
const imagesDir = (id) => path.join(sessionDir(id), 'images');
const refsDir = (id) => path.join(sessionDir(id), 'refs');
const metaPath = (id) => path.join(sessionDir(id), 'meta.json');

async function readMeta(id) {
  return JSON.parse(await fsp.readFile(metaPath(id), 'utf-8'));
}
async function writeMeta(id, meta) {
  await fsp.writeFile(metaPath(id), JSON.stringify(meta, null, 2));
}

// Image URL with a cache-busting token so a regenerated image refreshes.
function imageUrl(id, filename) {
  return `/api/sessions/${id}/image/${filename}?t=${Date.now()}`;
}

function timestampToFilename(hh, mm, ss) {
  return `${hh}${mm}${ss}.png`;
}

// Parse the prompt .txt file. Returns { entries, failed, totalBlocks }.
function parsePromptFile(text) {
  const blocks = text.split('---');
  const entries = [];
  const failed = [];
  let totalBlocks = 0;

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    totalBlocks += 1;

    const match = block.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
    if (!match) {
      failed.push(block.slice(0, 80));
      continue;
    }

    const [, hh, mm, ss] = match;
    const afterTimestamp = block.slice(match.index + match[0].length).trim();
    if (!afterTimestamp) {
      failed.push(`[${hh}:${mm}:${ss}] (empty prompt)`);
      continue;
    }

    entries.push({
      timecode: `${hh}:${mm}:${ss}`,
      filename: timestampToFilename(hh, mm, ss),
      prompt: afterTimestamp,
    });
  }

  return { entries, failed, totalBlocks };
}

function pushEvent(session, event) {
  if (!session) return;
  session.events.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of session.clients) client.write(payload);
}

function extractImage(response) {
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      const inline = part.inlineData;
      if (inline && inline.mimeType && inline.mimeType.startsWith('image/')) {
        return Buffer.from(inline.data, 'base64');
      }
    }
  }
  return null;
}

function extractText(response) {
  const candidates = response?.candidates || [];
  const texts = [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text.trim());
    }
  }
  return texts.join(' ').slice(0, 300);
}

// Build the content parts for one generation. If existingImage is provided, it's
// an adjustment pass: the model edits that image using the adjustment text.
function buildParts(refParts, scenePrompt, existingImageBuffer, adjustment) {
  const parts = [...refParts];
  let text = `${STYLE_ANCHOR}\n\nSCENE:\n${scenePrompt}`;
  if (adjustment) {
    if (existingImageBuffer) {
      parts.push({ inlineData: { data: existingImageBuffer.toString('base64'), mimeType: 'image/png' } });
    }
    text +=
      '\n\nADJUSTMENT — modify the existing image shown above. Keep the same composition, ' +
      'style, characters and framing; change only what is described here:\n' + adjustment;
  }
  parts.push({ text });
  return parts;
}

async function loadRefParts(id, meta) {
  const parts = [];
  for (const name of meta.refs || []) {
    if (!REF_RE.test(name)) continue;
    const buf = await fsp.readFile(path.join(refsDir(id), name));
    parts.push({ inlineData: { data: buf.toString('base64'), mimeType: 'image/png' } });
  }
  return parts;
}

async function generateImage(apiKey, parts) {
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: MODEL });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  });
  return result.response;
}

async function runGeneration(id) {
  const session = live.get(id);
  const meta = await readMeta(id);

  let refParts;
  try {
    refParts = session.refBuffers.map((b) => ({
      inlineData: { data: b.toString('base64'), mimeType: 'image/png' },
    }));
  } catch (err) {
    pushEvent(session, { type: 'fatal', message: 'Failed to read reference images: ' + err.message });
    meta.status = 'error';
    await writeMeta(id, meta);
    return;
  }

  let completed = 0, skipped = 0, errored = 0;

  for (let i = 0; i < meta.entries.length; i += 1) {
    const entry = meta.entries[i];
    if (entry.status === 'done') { completed += 1; continue; }
    if (i > 0) await sleep(API_DELAY_MS);

    try {
      const parts = buildParts(refParts, entry.prompt, null, null);
      const response = await generateImage(session.apiKey, parts);
      const buf = extractImage(response);

      if (!buf) {
        entry.status = 'skipped';
        entry.error = extractText(response) || 'No image returned (policy or text-only response).';
        skipped += 1;
        pushEvent(session, {
          type: 'image', status: 'skipped', filename: entry.filename,
          timecode: entry.timecode, message: entry.error,
        });
      } else {
        await fsp.writeFile(path.join(imagesDir(id), entry.filename), buf);
        entry.status = 'done';
        entry.error = null;
        completed += 1;
        pushEvent(session, {
          type: 'image', status: 'done', filename: entry.filename,
          timecode: entry.timecode, url: imageUrl(id, entry.filename),
        });
      }
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message || 'Generation failed.';
      errored += 1;
      pushEvent(session, {
        type: 'image', status: 'error', filename: entry.filename,
        timecode: entry.timecode, message: entry.error,
      });
    }

    await writeMeta(id, meta);
  }

  meta.status = 'complete';
  await writeMeta(id, meta);
  session.apiKey = null;
  session.refBuffers = null;
  pushEvent(session, { type: 'complete', completed, skipped, errored, total: meta.entries.length });
}

// ===================== BATCH MODE (Gemini Batch API) =====================
// Batch mode submits all prompts as one job for ~50% lower cost. It is
// asynchronous: we upload a JSONL job file, create a batch job, then poll until
// Google finishes and download the results. The API key is never stored on
// disk — it is supplied per request (submit / status check) and held only in
// memory for the duration of that request.

const GL_BASE = 'https://generativelanguage.googleapis.com';

async function uploadJsonlFile(apiKey, buffer, displayName) {
  const numBytes = buffer.length;
  const startRes = await fetch(`${GL_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': 'application/jsonl',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startRes.ok) throw new Error(`Upload start failed (${startRes.status}): ${await startRes.text()}`);
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API did not return an upload URL.');

  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(numBytes),
    },
    body: buffer,
  });
  if (!upRes.ok) throw new Error(`Upload failed (${upRes.status}): ${await upRes.text()}`);
  const data = await upRes.json();
  if (!data.file || !data.file.name) throw new Error('Files API upload returned no file name.');
  return data.file.name; // e.g. "files/abc123"
}

async function createBatch(apiKey, fileName, displayName) {
  const res = await fetch(`${GL_BASE}/v1beta/models/${MODEL}:batchGenerateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batch: { display_name: displayName, input_config: { file_name: fileName } },
    }),
  });
  if (!res.ok) throw new Error(`Batch create failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const name = data.name || (data.metadata && data.metadata.name);
  if (!name) throw new Error('Batch create returned no job name.');
  return name; // e.g. "batches/123"
}

async function pollBatch(apiKey, batchName) {
  const res = await fetch(`${GL_BASE}/v1beta/${batchName}`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`Batch status check failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function downloadResultFile(apiKey, fileName) {
  const res = await fetch(`${GL_BASE}/download/v1beta/${fileName}:download?alt=media`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`Results download failed (${res.status}): ${await res.text()}`);
  return res.text();
}

// The batch resource shape varies; read defensively from known locations.
function batchState(b) {
  return (b.metadata && b.metadata.state) || b.state || (b.batchStats && b.batchStats.state) || 'UNKNOWN';
}
function batchOutputFile(b) {
  return (
    (b.dest && b.dest.fileName) ||
    (b.response && b.response.responsesFile) ||
    (b.metadata && b.metadata.output && b.metadata.output.responsesFile) ||
    (b.output && b.output.responsesFile) ||
    (b.response && b.response.fileName) ||
    null
  );
}
function batchInlineResponses(b) {
  const r = b.response && b.response.inlinedResponses;
  if (!r) return null;
  return Array.isArray(r) ? r : r.inlinedResponses || null;
}

async function submitBatch(id, apiKey, refBuffers) {
  const meta = await readMeta(id);
  const refParts = refBuffers.map((refBuf) => ({
    inlineData: { data: refBuf.toString('base64'), mimeType: 'image/png' },
  }));
  const lines = meta.entries.map((e) =>
    JSON.stringify({
      key: e.filename,
      request: {
        contents: [{ role: 'user', parts: buildParts(refParts, e.prompt, null, null) }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      },
    }),
  );
  const jsonl = Buffer.from(lines.join('\n'), 'utf-8');

  const fileName = await uploadJsonlFile(apiKey, jsonl, `framefactory-${id}.jsonl`);
  const name = await createBatch(apiKey, fileName, meta.name);

  const m = await readMeta(id);
  m.batch = m.batch || {};
  m.batch.name = name;
  m.batch.state = 'JOB_STATE_PENDING';
  m.status = 'batch_running';
  await writeMeta(id, m);
}

async function ingestBatchResults(id, apiKey, meta, batchObj) {
  let records = [];
  const inline = batchInlineResponses(batchObj);
  if (inline) {
    for (let i = 0; i < inline.length; i += 1) {
      const r = inline[i];
      const key = (r.metadata && r.metadata.key) || (meta.entries[i] && meta.entries[i].filename);
      records.push({ key, response: r.response, error: r.error });
    }
  } else {
    const out = batchOutputFile(batchObj);
    if (!out) throw new Error('Batch finished but no results file was found in the response.');
    const text = await downloadResultFile(apiKey, out);
    records = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  for (const rec of records) {
    const entry = meta.entries.find((e) => e.filename === rec.key);
    if (!entry) continue;
    if (rec.error) {
      entry.status = 'error';
      entry.error = (typeof rec.error === 'string' ? rec.error : JSON.stringify(rec.error)).slice(0, 300);
      continue;
    }
    const buf = extractImage(rec.response);
    if (!buf) {
      entry.status = 'skipped';
      entry.error = extractText(rec.response) || 'No image returned (policy or text-only response).';
      continue;
    }
    await fsp.writeFile(path.join(imagesDir(id), entry.filename), buf);
    entry.status = 'done';
    entry.error = null;
  }
}

// Poll a batch once and, if finished, ingest its results. Idempotent.
async function refreshBatch(id, apiKey) {
  const meta = await readMeta(id);
  if (meta.mode !== 'batch') return meta;
  if (!meta.batch || !meta.batch.name) return meta; // still submitting
  if (meta.status === 'complete' || meta.status === 'error') return meta;

  const b = await pollBatch(apiKey, meta.batch.name);
  const state = batchState(b);
  meta.batch.state = state;

  if (state === 'JOB_STATE_SUCCEEDED' && !meta.batch.ingested) {
    await ingestBatchResults(id, apiKey, meta, b);
    meta.batch.ingested = true;
    meta.status = 'complete';
  } else if (['JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'].includes(state)) {
    meta.status = 'error';
    meta.batch.error = JSON.stringify(b.error || b.metadata || {}).slice(0, 300);
  }
  await writeMeta(id, meta);
  return meta;
}

function counts(meta) {
  return {
    done: meta.entries.filter((e) => e.status === 'done').length,
    skipped: meta.entries.filter((e) => e.status === 'skipped').length,
    errored: meta.entries.filter((e) => e.status === 'error').length,
    total: meta.entries.length,
  };
}

// ---- list sessions ----
app.get('/api/sessions', async (req, res) => {
  const ids = await fsp.readdir(DATA_DIR).catch(() => []);
  const out = [];
  for (const id of ids) {
    if (!validId(id)) continue;
    try {
      const meta = await readMeta(id);
      const done = meta.entries.filter((e) => e.status === 'done').length;
      const failed = meta.entries.filter((e) => e.status === 'error' || e.status === 'skipped').length;
      out.push({
        id: meta.id, name: meta.name, createdAt: meta.createdAt,
        total: meta.entries.length, done, failed, status: meta.status,
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  res.json(out);
});

// ---- session detail ----
app.get('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Bad id.' });
  try {
    const meta = await readMeta(id);
    const entries = meta.entries.map((e) => ({
      timecode: e.timecode,
      filename: e.filename,
      prompt: e.prompt,
      status: e.status,
      error: e.error || null,
      url: e.status === 'done' ? imageUrl(id, e.filename) : null,
    }));
    res.json({
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      status: meta.status,
      mode: meta.mode || 'live',
      batch: meta.batch
        ? { state: meta.batch.state, submittedAt: meta.batch.submittedAt, error: meta.batch.error || null }
        : null,
      entries,
    });
  } catch {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// ---- serve a generated image file ----
app.get('/api/sessions/:id/image/:filename', (req, res) => {
  const { id, filename } = req.params;
  if (!validId(id) || !IMG_RE.test(filename)) return res.status(400).end();
  res.sendFile(path.join(imagesDir(id), filename), (err) => {
    if (err) res.status(404).end();
  });
});

// ---- rename a session ----
app.patch('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Bad id.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required.' });
  try {
    const meta = await readMeta(id);
    meta.name = name.slice(0, 120);
    await writeMeta(id, meta);
    res.json({ ok: true, name: meta.name });
  } catch {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// ---- delete a session ----
app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Bad id.' });
  try {
    await fsp.rm(sessionDir(id), { recursive: true, force: true });
    live.delete(id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Delete failed.' });
  }
});

// ---- create a session and start generation ----
const createUpload = upload.fields([
  { name: 'referenceImages', maxCount: 5 },
  { name: 'promptFile', maxCount: 1 },
]);

app.post('/api/sessions', createUpload, async (req, res) => {
  const apiKey = (req.body.apiKey || '').trim();
  const name = (req.body.name || '').trim();
  const mode = req.body.mode === 'batch' ? 'batch' : 'live';
  const referenceImages = (req.files && req.files.referenceImages) || [];
  const promptFiles = (req.files && req.files.promptFile) || [];

  if (!apiKey) return res.status(400).json({ error: 'Gemini API key is required.' });
  if (referenceImages.length < 1) return res.status(400).json({ error: 'Upload at least one reference PNG.' });
  if (promptFiles.length < 1) return res.status(400).json({ error: 'Upload a prompt .txt file.' });

  const promptText = promptFiles[0].buffer.toString('utf-8');
  const { entries, failed, totalBlocks } = parsePromptFile(promptText);

  if (entries.length === 0) {
    return res.status(400).json({
      error: 'No valid timecode blocks were parsed from the prompt file.',
      failed, totalBlocks,
    });
  }

  const confirmed = req.body.confirm === 'true';
  if (failed.length > 0 && !confirmed) {
    return res.status(409).json({ needsConfirmation: true, parsed: entries.length, totalBlocks, failed });
  }

  const id = crypto.randomUUID();
  await fsp.mkdir(imagesDir(id), { recursive: true });
  await fsp.mkdir(refsDir(id), { recursive: true });

  const refNames = [];
  for (let i = 0; i < referenceImages.length; i += 1) {
    const n = `ref${i}.png`;
    await fsp.writeFile(path.join(refsDir(id), n), referenceImages[i].buffer);
    refNames.push(n);
  }

  const meta = {
    id,
    name: (name || `Session ${new Date().toLocaleString()}`).slice(0, 120),
    createdAt: Date.now(),
    refs: refNames,
    mode,
    status: mode === 'batch' ? 'batch_submitting' : 'running',
    batch: mode === 'batch'
      ? { name: null, state: 'SUBMITTING', submittedAt: Date.now(), ingested: false, error: null }
      : null,
    entries: entries.map((e) => ({
      timecode: e.timecode, filename: e.filename, prompt: e.prompt, status: 'pending', error: null,
    })),
  };
  await writeMeta(id, meta);

  if (mode === 'batch') {
    res.json({ sessionId: id, mode, total: entries.length, parsed: entries.length, failed });
    submitBatch(id, apiKey, referenceImages.map((r) => r.buffer)).catch(async (err) => {
      try {
        const m = await readMeta(id);
        m.status = 'error';
        m.batch = m.batch || {};
        m.batch.state = 'JOB_STATE_FAILED';
        m.batch.error = (err && err.message) || 'Batch submit failed.';
        await writeMeta(id, m);
      } catch { /* ignore */ }
    });
    return;
  }

  const session = {
    id, apiKey,
    refBuffers: referenceImages.map((r) => r.buffer),
    events: [], clients: [], status: 'running',
  };
  live.set(id, session);

  res.json({ sessionId: id, mode, total: entries.length, parsed: entries.length, failed });

  runGeneration(id).catch((err) => {
    pushEvent(session, { type: 'fatal', message: err.message });
  });
});

// ---- check/advance a batch job's status ----
app.post('/api/sessions/:id/batch-status', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Bad id.' });
  const apiKey = (req.body.apiKey || '').trim();

  let meta;
  try { meta = await readMeta(id); } catch { return res.status(404).json({ error: 'Session not found.' }); }
  if (meta.mode !== 'batch') return res.json({ mode: 'live', status: meta.status, counts: counts(meta) });

  let pollError = null;
  if (apiKey && meta.batch && meta.batch.name && meta.status !== 'complete' && meta.status !== 'error') {
    try { meta = await refreshBatch(id, apiKey); }
    catch (err) { pollError = (err && err.message) || 'Status check failed.'; }
  }

  res.json({
    mode: 'batch',
    status: meta.status,
    state: (meta.batch && meta.batch.state) || 'SUBMITTING',
    submittedAt: (meta.batch && meta.batch.submittedAt) || null,
    error: (meta.batch && meta.batch.error) || null,
    pollError,
    counts: counts(meta),
  });
});

// ---- regenerate a single image (optionally with an adjustment prompt) ----
app.post('/api/sessions/:id/regenerate', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Bad id.' });

  const apiKey = (req.body.apiKey || '').trim();
  const filename = (req.body.filename || '').trim();
  const adjustment = (req.body.adjustment || '').trim();

  if (!apiKey) return res.status(400).json({ error: 'Gemini API key is required.' });
  if (!IMG_RE.test(filename)) return res.status(400).json({ error: 'Bad filename.' });

  let meta;
  try { meta = await readMeta(id); } catch { return res.status(404).json({ error: 'Session not found.' }); }

  const entry = meta.entries.find((e) => e.filename === filename);
  if (!entry) return res.status(404).json({ error: 'Image not found in session.' });

  try {
    const refParts = await loadRefParts(id, meta);

    let existing = null;
    if (adjustment) {
      existing = await fsp.readFile(path.join(imagesDir(id), filename)).catch(() => null);
    }

    const parts = buildParts(refParts, entry.prompt, existing, adjustment);
    const response = await generateImage(apiKey, parts);
    const buf = extractImage(response);

    if (!buf) {
      const msg = extractText(response) || 'No image returned (policy or text-only response).';
      entry.status = 'skipped';
      entry.error = msg;
      await writeMeta(id, meta);
      return res.json({ status: 'skipped', message: msg });
    }

    await fsp.writeFile(path.join(imagesDir(id), filename), buf);
    entry.status = 'done';
    entry.error = null;
    if (meta.status === 'error') meta.status = 'complete';
    await writeMeta(id, meta);
    res.json({ status: 'done', url: imageUrl(id, filename) });
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message || 'Generation failed.';
    await writeMeta(id, meta);
    res.status(500).json({ status: 'error', message: entry.error });
  }
});

// ---- progress stream for an active generation ----
app.get('/progress/:id', (req, res) => {
  const session = live.get(req.params.id);
  if (!session) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  for (const event of session.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  session.clients.push(res);

  req.on('close', () => {
    const idx = session.clients.indexOf(res);
    if (idx !== -1) session.clients.splice(idx, 1);
  });
});

// ---- download all images as a zip (png or jpeg) ----
app.get('/download/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).send('Bad id.');

  let files;
  try {
    files = (await fsp.readdir(imagesDir(id))).filter((f) => IMG_RE.test(f)).sort();
  } catch {
    return res.status(404).send('Session not found.');
  }
  if (!files.length) return res.status(400).send('No images available to download.');

  const format = req.query.format === 'jpeg' ? 'jpeg' : 'png';
  const zipName = format === 'jpeg' ? 'framefactory_export_jpeg.zip' : 'framefactory_export.zip';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(err.message));
  archive.pipe(res);

  for (const f of files) {
    const buf = await fsp.readFile(path.join(imagesDir(id), f));
    if (format === 'jpeg') {
      const jpeg = await sharp(buf).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
      archive.append(jpeg, { name: f.replace(/\.png$/, '.jpg') });
    } else {
      archive.append(buf, { name: f });
    }
  }
  archive.finalize();
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Frame Factory running on http://localhost:${PORT}`);
});
