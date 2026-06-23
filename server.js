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
    res.json({ id: meta.id, name: meta.name, createdAt: meta.createdAt, status: meta.status, entries });
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
    status: 'running',
    entries: entries.map((e) => ({
      timecode: e.timecode, filename: e.filename, prompt: e.prompt, status: 'pending', error: null,
    })),
  };
  await writeMeta(id, meta);

  const session = {
    id, apiKey,
    refBuffers: referenceImages.map((r) => r.buffer),
    events: [], clients: [], status: 'running',
  };
  live.set(id, session);

  res.json({ sessionId: id, total: entries.length, parsed: entries.length, failed });

  runGeneration(id).catch((err) => {
    pushEvent(session, { type: 'fatal', message: err.message });
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
