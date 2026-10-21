# Highlight

Highlight turns a YouTube video or an uploaded video into a chronological MP4 highlight reel. Choose 5–50% of the original length in 5% steps (20% by default, with a 4% selection tolerance). The implementation in this repository uses **React, TypeScript, Express, Gemini, yt-dlp, and FFmpeg**.

Gemini receives the actual source video through Google's Files API, including its audio and visual content. The server waits for processing, requests structured timestamped candidates, and removes the remote file afterwards. Candidate scores combine 40% semantic importance, 25% authorized audience retention, 15% visual importance, 10% audio, and 10% context. Missing engagement weight is redistributed across the other signals. Public replay heatmaps are not currently collected; optional channel-owner retention comes from the YouTube Analytics API using a supplied OAuth access token.

## Run locally

Use Node.js 24 LTS with npm. Install yt-dlp for YouTube links; uploads do not require it.

```bash
# macOS
brew install node ffmpeg yt-dlp

npm ci
cp .env.example .env
# Edit .env and set GEMINI_API_KEY to your Google AI Studio API key.
npm run dev
```

Open http://localhost:3000. On Linux, install FFmpeg using your distribution's package manager and install `yt-dlp[default]` in a Python virtual environment. Set `YT_DLP_BIN` to that environment's executable. The [yt-dlp installation guide](https://github.com/yt-dlp/yt-dlp#installation) covers other platforms. npm also installs bundled FFmpeg/FFprobe; set `FFMPEG_PATH` and `FFPROBE_PATH` to use system binaries explicitly.

Validation and production startup:

```bash
npm run lint
npm test
npm run build
npm start
```

The build creates `dist/` for the frontend and `dist-server/server.js` for the server. `npm start` serves both in production mode. `npm run preview` previews only the static frontend and is not the full application.

The fixes are local until committed and pushed. If using the repair branch from this workspace, publish it with:

```bash
git add .
git commit -m "Fix video analysis, rendering, access checks, and deployment"
git push -u https://github.com/MalharBhide/Highlight.git codex/fix-highlight
```

Select that branch in Render, or merge it into `main` first.

## Configuration

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Required for real AI analysis; keep it on the server. Get it from [Google AI Studio](https://aistudio.google.com/apikey). |
| `GEMINI_MODEL` | Video-capable model available to your account; defaults to `gemini-3.8-flash`. |
| `YOUTUBE_API_KEY` | Optional YouTube Data API v3 key for richer metadata and duration. |
| `STORAGE_DIR` | Database, caches, uploads, and renders; defaults to an OS temporary directory. Set a persistent directory when hosting. |
| `MEDIA_STORAGE_DIR` | Optional separate media directory; otherwise follows `STORAGE_DIR`. Both locations must persist if separated. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Optional executable overrides. Docker uses `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`. |
| `YT_DLP_BIN` | Optional yt-dlp executable path. |
| `ALLOW_HEURISTIC_FALLBACK` | `false` by default. Set `true` to allow clearly labeled audio/timing selections if Gemini is unavailable. This mode does not understand the video's meaning. |
| `ENABLE_DEV_FIXTURES` | `false` by default in production; development fixture IDs are disabled unless enabled explicitly. |
| `PORT` | HTTP port, defaults to 3000. |

Supported uploads: MP4, MOV, WebM, MKV, and M4V, up to 500 MB, between 10 seconds and four hours. YouTube downloads are limited to 500 MB and four hours. Local uploads are retained to support retries and changing the percentage; deleting a reel removes its private upload and output.

The browser stores a random capability token locally. Job APIs require this token, and video playback includes it in the media URL. This provides a browser-specific library, not an account login or cross-device synchronization. Clearing browser storage loses access to the library.

## Host on Render

Use a **Docker Web Service with a persistent disk**. The included `render.yaml` defines one paid `1c-2g` instance (1 CPU, 2 GB RAM) and a 20 GB disk. Review Render's current cost before creating it. Video rendering needs CPU, memory, and persistent disk; a static website host alone cannot run this application.

1. Commit and push the repaired code, including `Dockerfile`, `package-lock.json`, and `render.yaml`, to your GitHub repository.
2. In Render, choose **New → Blueprint**, connect the repository, and select the branch containing the fixes. Render reads `render.yaml`.
3. Enter your `GEMINI_API_KEY`. Supply `YOUTUBE_API_KEY` if you have one; otherwise leave it blank. If needed, change `GEMINI_MODEL` to a video-capable model your Google account can access.
4. Review the paid service and disk configuration, then deploy. The Docker image installs Node, FFmpeg, FFprobe, Python, and yt-dlp automatically.
5. Open the generated `https://…onrender.com` URL. `/healthz` should return `{"status":"ok"}`. Test a short video upload, wait for completion, play it, and download the MP4. Then test a YouTube URL.
6. To use your own domain, add it in the service's Custom Domains settings and follow Render's DNS instructions.

If configuring the service manually instead of using a Blueprint, select **Docker**, use the repository root, leave Docker Command empty, set the health check to `/healthz`, and attach a disk at `/app/storage`. Set `STORAGE_DIR=/app/storage`, `GEMINI_API_KEY`, and optionally `YOUTUBE_API_KEY` / `GEMINI_MODEL`.

Render's [Docker documentation](https://render.com/docs/docker), [web service guide](https://render.com/docs/web-services), and [disk documentation](https://render.com/docs/disks) describe these settings. A disk requires a paid service; the default filesystem is ephemeral. Keep **one instance and one Node process** because the current application uses an in-memory job queue and a local JSON database. Move to a shared database, durable queue, and object storage before scaling to multiple instances. Back up `/app/storage` and monitor its available space.

## Run the same container elsewhere

```bash
docker build -t highlight .
docker volume create highlight-storage
docker run --rm -p 3000:3000 --env-file .env \
  -e STORAGE_DIR=/app/storage \
  -v highlight-storage:/app/storage highlight
```

A VPS or another Docker host can run this image. Put HTTPS in front of it and persist `/app/storage`. The container runs as a non-root user; if using a bind mount, give UID 1000 write access to it.

## Failure behavior and verification

- Failed YouTube downloads return an actionable error asking for an upload. They never substitute generated footage. YouTube can block downloads from hosting-provider IP addresses; update yt-dlp by rebuilding the image and use a video upload if access remains blocked.
- Gemini errors are reported as failures by default. Check the server logs for Google's error, verify the API key, quota, model access, and video format. See Google's [video understanding guide](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding) for supported media input.
- FFmpeg re-encodes cuts at the requested timestamps. The reported duration is measured from the resulting file instead of being replaced with the planned duration.
- Jobs run sequentially with a maximum of ten pending/running jobs. Interrupted jobs resume on restart; failed jobs wait for an explicit retry. OAuth access tokens are not persisted, so a resumed job may lack audience analytics.
- Tests cover scoring, duration selection, the Gemini upload/processing/request/cleanup contract with a mock client, ownership on every job endpoint, rejected-upload cleanup, MP4 downloads, suffix/invalid byte ranges, and actual FFmpeg rendering with and without source audio.

Live Gemini and YouTube behavior still depends on valid credentials and external service access. Mock tests do not establish that a particular API key or hosted IP has access. The Docker image must also be built on a machine with a running Docker daemon.
