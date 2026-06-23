# Frame Factory

Automated YouTube explainer image generation using the Gemini image API (Nano Banana).

Paste your Gemini API key, upload your character reference PNGs and a timecoded
prompt `.txt` file, click one button, and download a ZIP of consistently-styled
16:9 images named by timecode — ready to import into Premiere Pro as an image
sequence in chronological order.

## How it works

- One still image is generated per timecode entry in your prompt file.
- All reference PNGs are passed into every API call so characters stay consistent.
- A fixed style anchor (lo-fi 2D doodle, white background, 16:9 widescreen) is
  prepended to every prompt.
- Images are named `HHMMSS.png` (e.g. `000000.png`, `000005.png`) so they sort
  in correct order in Premiere Pro.

## Saved sessions

- Every run is saved as a named **session** and listed in the history sidebar on
  the left — your images are not lost if some frames fail.
- Click any frame to open it. From there you can **Regenerate** it with the same
  prompt (useful for failed frames) or type an **adjustment** ("make him point
  left", "add a sun") to tweak that single image, the way you would in Nano Banana.
- Download a session as a PNG ZIP or a JPEG ZIP at any time.

### Where saved data lives (important for Railway)

Sessions are stored on disk in a `data/` folder. **Railway wipes the filesystem
on every redeploy**, so to keep your sessions you must add a persistent Volume:

1. In your Railway project, open your service → **Settings** → scroll to **Volumes**.
2. Click **Add Volume** (or **New Volume**) and set the **Mount path** to:
   `/app/data`
3. Save. Your sessions now survive redeploys.

(Locally, data is simply stored in the project's `data/` folder.)

## Setup

### a. Get a free Gemini API key

Go to [aistudio.google.com](https://aistudio.google.com) and create an API key.

### b. Clone the repo / download the files

Download or clone this project to your machine.

### c. Run locally

```bash
npm install && npm start
```

Then open <http://localhost:3000>.

### d. Deploy to Railway

1. Push this project to a GitHub repo.
2. In Railway, create a new project and connect the GitHub repo.
3. Railway auto-detects Node.js and runs `npm install` then `npm start`.
4. Click **Deploy**. Done — the app is now reachable from any device.

### e. Estimated cost

Roughly **~$0.039 per image** on Gemini 2.5 Flash Image. A 100-image episode
costs about **$4**. Use the Google AI Studio free tier to test first (limited
free generations per day).

## Prompt file format

```
[00:00:00]
Stick figure narrator stands centre frame, pointing upward. Caption: "WORST CROSSOVER EVENT EVER"

---

[00:00:05]
King Kong and Godzilla silhouettes on a tiny island labeled "PRIVATE ISLAND." Deadpan expressions.

---

[00:00:10]
Same three figures walking toward a simple city skyline. Calendar icon above: "SAME WEEK."
```

- Blocks are separated by `---`.
- Each block starts with a `[HH:MM:SS]` timestamp, followed by the scene prompt.
- Blocks without a valid timestamp are skipped (you'll be asked to confirm first).

## Security

- Your Gemini API key is sent from the browser to the backend **per request only**.
- It is **never logged** and **never written to disk** on the server.
- It is cleared from server memory once the batch completes.
- For convenience, the key is kept in your own browser's local storage so you
  don't have to re-paste it for adjustments. It never leaves your device except
  in the per-request calls above. Clear your browser data to remove it.
- **Never share your API key** with anyone, and don't commit it to a repo.
