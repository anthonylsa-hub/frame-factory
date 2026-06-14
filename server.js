require('dotenv').config();

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const crypto = require('crypto');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

const MODEL = 'gemini-3.1-flash-image-preview';

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

// sessionId -> session state. Kept in memory only.
const sessions = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // Everything after the timestamp line is the scene prompt.
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

// Send an SSE event to every connected client for a session, and buffer it
// so clients that connect later still receive prior events.
function pushEvent(session, event) {
  session.events.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of session.clients) {
    client.write(payload);
  }
}

// Extract the first inline image part from a Gemini response.
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

async function runGeneration(session) {
  const { entries, referenceImages, apiKey } = session;

  let genAI;
  let model;
  try {
    genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: MODEL });
  } catch (err) {
    pushEvent(session, { type: 'fatal', message: 'Failed to initialise Gemini client: ' + err.message });
    session.status = 'error';
    return;
  }

  const referenceParts = referenceImages.map((img) => ({
    inlineData: { data: img.buffer.toString('base64'), mimeType: 'image/png' },
  }));

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (i > 0) await sleep(API_DELAY_MS);

    const combinedText = `${STYLE_ANCHOR}\n\nSCENE:\n${entry.prompt}`;
    const parts = [...referenceParts, { text: combinedText }];

    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      });

      const imageBuffer = extractImage(result.response);

      if (!imageBuffer) {
        // Gemini returned text (often a policy/refusal message) instead of an image.
        session.skipped += 1;
        pushEvent(session, {
          type: 'image',
          status: 'skipped',
          index: i,
          timecode: entry.timecode,
          filename: entry.filename,
          message: 'No image returned (policy or text-only response). Skipped.',
        });
      } else {
        session.images.set(entry.filename, imageBuffer);
        session.completed += 1;
        pushEvent(session, {
          type: 'image',
          status: 'done',
          index: i,
          timecode: entry.timecode,
          filename: entry.filename,
          dataUrl: `data:image/png;base64,${imageBuffer.toString('base64')}`,
        });
      }
    } catch (err) {
      session.errored += 1;
      pushEvent(session, {
        type: 'image',
        status: 'error',
        index: i,
        timecode: entry.timecode,
        filename: entry.filename,
        message: err.message || 'Generation failed.',
      });
    }
  }

  session.status = 'complete';
  // Wipe the API key from memory now that the batch is finished.
  session.apiKey = null;
  pushEvent(session, {
    type: 'complete',
    completed: session.completed,
    skipped: session.skipped,
    errored: session.errored,
    total: entries.length,
  });
}

const generateUpload = upload.fields([
  { name: 'referenceImages', maxCount: 5 },
  { name: 'promptFile', maxCount: 1 },
]);

app.post('/generate', generateUpload, async (req, res) => {
  const apiKey = (req.body.apiKey || '').trim();
  const referenceImages = (req.files && req.files.referenceImages) || [];
  const promptFiles = (req.files && req.files.promptFile) || [];

  if (!apiKey) {
    return res.status(400).json({ error: 'Gemini API key is required.' });
  }
  if (referenceImages.length < 1) {
    return res.status(400).json({ error: 'Upload at least one reference PNG.' });
  }
  if (promptFiles.length < 1) {
    return res.status(400).json({ error: 'Upload a prompt .txt file.' });
  }

  const promptText = promptFiles[0].buffer.toString('utf-8');
  const { entries, failed, totalBlocks } = parsePromptFile(promptText);

  if (entries.length === 0) {
    return res.status(400).json({
      error: 'No valid timecode blocks were parsed from the prompt file.',
      failed,
      totalBlocks,
    });
  }

  // If the caller hasn't confirmed yet and some blocks failed, ask them to confirm.
  const confirmed = req.body.confirm === 'true';
  if (failed.length > 0 && !confirmed) {
    return res.status(409).json({
      needsConfirmation: true,
      parsed: entries.length,
      totalBlocks,
      failed,
    });
  }

  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    apiKey,
    referenceImages,
    entries,
    images: new Map(),
    events: [],
    clients: [],
    status: 'running',
    completed: 0,
    skipped: 0,
    errored: 0,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);

  res.json({ sessionId, total: entries.length, parsed: entries.length, failed });

  // Kick off generation in the background.
  runGeneration(session).catch((err) => {
    session.status = 'error';
    pushEvent(session, { type: 'fatal', message: err.message });
  });
});

app.get('/progress/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  // Replay buffered events so a late-connecting client catches up.
  for (const event of session.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  session.clients.push(res);

  req.on('close', () => {
    const idx = session.clients.indexOf(res);
    if (idx !== -1) session.clients.splice(idx, 1);
  });
});

app.get('/download/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).send('Session not found.');
  }
  if (session.images.size === 0) {
    return res.status(400).send('No images available to download.');
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="framefactory_export.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    res.status(500).end(err.message);
  });
  archive.pipe(res);

  const filenames = Array.from(session.images.keys()).sort();
  for (const filename of filenames) {
    archive.append(session.images.get(filename), { name: filename });
  }
  archive.finalize();
});

app.use(express.static(path.join(__dirname, 'public')));

// Periodically clean up old sessions (and their buffers) to free memory.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Frame Factory running on http://localhost:${PORT}`);
});
