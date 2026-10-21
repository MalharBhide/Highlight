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

Deploy the `main` branch, which contains the repaired application and deployment configuration.

## Configuration

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Required for real AI analysis; keep it on the server. Get it from [Google AI Studio](https://aistudio.google.com/apikey). |
| `GEMINI_MODEL` | Video-capable model available to your account; defaults to `gemini-3.8-flash`. |
| `YOUTUBE_API_KEY` | Optional YouTube Data API v3 key for richer metadata and duration. |
| `STORAGE_DIR` | Database, caches, uploads, and renders; temporary on Render Free. Set a local directory to retain files on your computer. |
| `MEDIA_STORAGE_DIR` | Optional separate media directory; otherwise follows `STORAGE_DIR`. Both locations must persist if separated. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Optional executable overrides. Docker uses `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`. |
| `YT_DLP_BIN` | Optional yt-dlp executable path. |
| `ALLOW_HEURISTIC_FALLBACK` | `false` by default. Set `true` to allow clearly labeled audio/timing selections if Gemini is unavailable. This mode does not understand the video's meaning. |
| `ENABLE_DEV_FIXTURES` | `false` by default in production; development fixture IDs are disabled unless enabled explicitly. |
| `FREE_DEMO_MODE` | Enables the limited resource profile used by Render Free. Defaults to `false` locally. |
| `PORT` | HTTP port, defaults to 3000. |

Supported formats: MP4, MOV, WebM, MKV, and M4V. Local/full mode permits up to 500 MB and four hours (minimum 10 seconds). Render Free demo mode permits up to 50 MB and five minutes, with source resolution up to 1080p. Local uploads are retained to support retries and changing the percentage; deleting a reel removes its private upload and output.

The browser stores a random capability token locally. Job APIs require this token, and video playback includes it in the media URL. This provides a browser-specific library, not an account login or cross-device synchronization. Clearing browser storage loses access to the library.

## Host for $0 on Render Free

The included `render.yaml` now uses **Render Free**, with no paid instance and no persistent disk. This is a small public demo, not an always-on production service. `FREE_DEMO_MODE=true` limits inputs to **5 minutes, 50 MB, and 1080p**, renders at **up to 480p** with one FFmpeg thread, and accepts one processing job at a time. Running locally with the flag disabled keeps the full limits and HD output.

1. Open [Render](https://dashboard.render.com/) and connect your GitHub account.
2. Choose **New → Blueprint**, select `MalharBhide/Highlight`, choose **`main`**, and leave the Blueprint path as `render.yaml`.
3. Confirm that the service plan says **Free** and no disk or paid resource is listed. Keep the free `onrender.com` address rather than buying a domain.
4. Enter a `GEMINI_API_KEY` from a **Gemini API free-tier project** in [Google AI Studio](https://aistudio.google.com/apikey). Keep Google Cloud billing disabled to stay within a $0 budget. The configured `gemini-3.8-flash` supports free-tier input/output, subject to account availability and rate limits. Do not enable paid billing to bypass a quota error. `YOUTUBE_API_KEY` is optional; leave it blank if you do not have one.
5. Click **Deploy Blueprint**. Docker installs the runtime and media tools automatically. No separate frontend deployment is needed.
6. Open your generated `https://…onrender.com` URL. Check `/healthz`, upload a short video, and test playback and MP4 download. Start with a 20–60 second upload; the free CPU is slow. Then try a short YouTube link.

For manual setup, choose **New → Web Service → Docker**, branch `main`, plan **Free**, health check `/healthz`, and no disk. Set `FREE_DEMO_MODE=true`, `STORAGE_DIR=/app/storage`, `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.8-flash`, and `ALLOW_HEURISTIC_FALLBACK=false`. Leave Docker Command empty.

**Free hosting limits:** Render sleeps after 15 minutes without traffic. Waking it takes about a minute, and local files are lost on sleep, restart, or redeploy. Download each reel immediately; the library is temporary. The banner in the app explains this. Free accounts also have monthly runtime/build/bandwidth limits. Keep Render on its free plan, do not add a payment method for overages, and let the service suspend when the allowance runs out. Render may require account verification; if it requires a payment method you do not want to provide, use the local option below. See [Render's free-tier documentation](https://render.com/docs/free) and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).

This configuration requests no paid hosting resources, but cannot prevent API charges if you supply a key from a billing-enabled Google project. Render and Google quota eligibility are separate. Video downloading may also be blocked from hosting-provider IPs; uploads avoid that dependency. A small free server cannot guarantee successful processing of every video within its input limits.

**For longer videos at $0:** run `npm run dev` on your own computer and use the same free-tier Gemini key. Your computer handles FFmpeg, and a local storage directory retains your files. This is accessible locally while the server runs, rather than a publicly hosted site. A free static-only host cannot execute this application's Node/FFmpeg backend.

Keep one instance and one Node process. A paid server is not required to try the app, and the repository no longer requests one by default.

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

## Verify the deployment image

With Docker running:

```bash
docker build -t highlight:test .
npm run test:docker
```

This test starts an isolated non-root container with a temporary persistent volume, checks the homepage and built assets, verifies FFmpeg/FFprobe and yt-dlp, compiles a real video, downloads it, and confirms the reel remains available after a restart. It removes its test container and volume afterwards.

The API integration suite also exercises every supported percentage from 5% through 50%, source replacement, changing a reel's percentage, retries, explicit rendering, persistence, and missing-key failures. GitHub Actions runs the production build and both test suites on each push.

To exercise the free demo's memory/CPU profile in Docker:

```bash
HIGHLIGHT_TEST_FREE_DEMO=true npm run test:docker
```

This runs the container with 512 MB RAM and 0.1 CPU, matching the published free compute limits. It verifies a short test video; it does not establish capacity for every video or traffic level.
