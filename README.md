# Highlight — AI-Powered YouTube Highlight Generator

**Tagline:** *Watch less. See the best.*

Highlight transforms long YouTube videos into concise, chronological highlight reels using a single unified pipeline combining **Google Gemini video understanding**, **authorized audience retention analytics**, and **FFmpeg H.264/AAC editing**.

---

## Core Formula & Unified Scoring

- **Target Highlight Duration:**
  $$T_{\text{highlight}} = \min(0.20 \times T_{\text{original}}, 600)$$
  All durations are in seconds (20% of the original video duration, capped at 10 minutes / 600 seconds, with a ±5% boundary-snapping tolerance).
- **Unified Multi-Signal Scoring:**
  - `40%` Semantic Importance (key arguments, conclusions, announcements, turning points)
  - `25%` Audience Engagement (smoothed local prominence peaks from YouTube Analytics retention data)
  - `15%` Visual Importance (demonstrations, action sequences, visual transitions)
  - `10%` Audio & Emotional Importance (excitement, applause, emotional delivery — with an anti-loudness-only penalty)
  - `10%` Contextual Importance (narrative setups, payoffs, and natural scene boundaries)
- **Automatic Missing-Engagement Fallback:**
  Because YouTube's public Most Replayed heatmap is not exposed via an official public API, Highlight automatically redistributes the 25% engagement weight proportionally across Gemini's signals when channel-owner retention data is unavailable.

---

## Environment Variables (`.env`)

Copy `.env.example` to `.env` and configure:

- `GEMINI_API_KEY`: Required for live Google Gemini (`gemini-3.8-flash`) video analysis.
- `YOUTUBE_API_KEY`: Optional YouTube Data API v3 key for exact ISO-8601 duration and snippet lookup. When omitted, Highlight falls back to official YouTube oEmbed metadata + `ffprobe` source duration verification.
- `STORAGE_DIR`: Directory for uploaded authorized video files and rendered MP4 reels (defaults to `/tmp/highlight-storage`).

---

## Local Development & Testing

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Run unit tests (scoring, duration formula, URL validation, clip selection):**
   ```bash
   npm test
   ```
3. **Start the full-stack development server (port 3000):**
   ```bash
   npm run dev
   ```
4. **Build for production deployment:**
   ```bash
   npm run build
   npm start
   ```
