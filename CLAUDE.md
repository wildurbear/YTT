# CLAUDE.md — YouTube Transcriber Tool (YTT)

## Project Overview

A personal, single-user web app that accepts a YouTube URL, fetches the video transcript, and returns a structured AI-generated summary. The goal is to eliminate the manual copy-paste pipeline (YouTube → transcript site → ChatGPT) with one clean interface accessible from any device.

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js | Minimal dependencies, Railway-native |
| Framework | Express.js | Lightweight, sufficient for a single-user tool |
| Transcript Fetching | `youtube-transcript` npm package | Handles both auto-generated and creator-uploaded captions |
| AI Summarization | Anthropic SDK (`@anthropic-ai/sdk`) and/or OpenAI SDK (`openai`) | See AI Provider section below |
| Auth | JWT (JSON Web Tokens) via `jsonwebtoken` | Session tokens stored in `httpOnly` cookies |
| Password Hashing | `bcrypt` | For comparing the stored hashed master password |
| Frontend | Vanilla HTML/CSS/JS | No framework needed; keep it simple and mobile-first |
| Hosting | Railway | Free plan; upgrade to paid if memory limits are hit |
| Source Control | GitHub | Standard; do not commit `.env` |

---

## Project Structure

```
ytt/
├── server.js              # Express app, auth routes, API routes
├── package.json
├── .env                   # Secrets — NEVER commit this
├── .gitignore             # Must include .env, node_modules
├── public/
│   ├── index.html         # Login page (shown when unauthenticated)
│   ├── app.html           # Main tool UI (protected route)
│   ├── style.css          # Shared styles — mobile-first responsive
│   └── app.js             # Frontend JS for app.html
└── CLAUDE.md              # This file
```

---

## Authentication Design

### Goals
- Authenticate **once per device** with a strong master password.
- Stay logged in for a configurable number of days (default: 30 days).
- New device = re-authenticate but persistent per device (doesn't kick you out of one). Not a multi-user system.

### Implementation
- On login, `bcrypt.compare()` the submitted password against `HASHED_PASSWORD` from `.env`.
- On success, sign a JWT (`jsonwebtoken`) with a 30-day expiry and set it as an `httpOnly`, `Secure`, `SameSite=Strict` cookie.
- Every protected route/API call checks for a valid JWT cookie via middleware. Invalid or expired = redirect to login.
- The JWT secret (`JWT_SECRET`) must be a long random string stored in `.env`.

### Setup: Generating the Hashed Password
Before first run, generate the hashed password once in a throwaway script or Node REPL:
```js
const bcrypt = require('bcrypt');
bcrypt.hash('YourStrongPasswordHere', 12).then(console.log);
```
Paste the output into `.env` as `HASHED_PASSWORD`.

### Auth Security Hardening
- Rate-limit login attempts: use `express-rate-limit` on the `/login` POST route. Suggested: 3 attempts per 3 hours per IP.
- Log failed login attempts server-side (console is fine; no DB needed).
- No "forgot password" flow — this is intentional. Reset by updating `HASHED_PASSWORD` in Railway env vars.
- Do NOT expose whether the password was wrong vs. the user doesn't exist — always return a generic "Invalid credentials" message.

---

## Environment Variables (`.env`)

```
# Auth
HASHED_PASSWORD=       # bcrypt hash of your master password
JWT_SECRET=            # long random string, e.g. openssl rand -hex 64

# AI Provider(s)
ANTHROPIC_API_KEY=     # for Claude
OPENAI_API_KEY=        # for GPT-4o (optional, see AI Provider section)

# Config
SESSION_DAYS=30        # how long login tokens last
PORT=3000              # Railway sets this automatically; keep as fallback
```

Set these in Railway's **Variables** tab, not in any committed file.

---

## URL Validation (Prompt Injection Defense)

This validation must happen **in server.js** before the URL is passed anywhere — not in the frontend alone, not inside an AI prompt.

### Allowed domains (hard-coded whitelist):
- `youtube.com` (including `www.youtube.com`)
- `youtu.be`
- `m.youtube.com`

### Implementation pattern:
```js
const ALLOWED_YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

function isValidYouTubeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    // Must be HTTPS
    if (url.protocol !== 'https:') return false;
    // Must be an allowed host (exact match, no partial)
    if (!ALLOWED_YOUTUBE_HOSTS.includes(url.hostname)) return false;
    return true;
  } catch {
    return false; // malformed URL
  }
}
```

If `isValidYouTubeUrl()` returns false, respond immediately with HTTP 400 and a generic error. **Do not pass the input to the transcript fetcher or AI under any circumstances.**

The frontend can show a friendly error message, but the enforcement lives server-side.

---

## AI Provider Configuration

The app should support **both Anthropic and OpenAI**, switchable with a single env var rather than commenting out code.

### Switching mechanism
In `.env`:
```
AI_PROVIDER=anthropic   # or: openai
```

In `server.js`, a single dispatcher function reads `AI_PROVIDER` and calls the correct SDK. Neither SDK is imported/called if not in use.

### Summarization prompt
Send the transcript as user content. Keep the system prompt minimal — the output format spec handles structure:

**System prompt:**
```
You are a concise summarization assistant. You receive YouTube video transcripts and return a structured summary. Follow the output format exactly. Do not editorialize or add information not present in the transcript.
```

**User message:**
```
Summarize the following transcript:

<transcript>
{transcript text here}
</transcript>
```

Note: Wrapping the transcript in `<transcript>` tags and explicitly calling it a transcript — not instructions — is intentional prompt injection mitigation. The AI provider receives clean, labeled content, not raw user input.

---

## Output Format

The AI must be prompted to return summaries in exactly this Markdown structure:

```
# Title
[video title]

## TLDR
[one to three sentence summary]

## Main Takeaways
- [takeaway]
- [takeaway]
- [takeaway]

## Detailed Summary
[paragraph-form detailed summary]

## Notable Quotes
- "[quote]"
- "[quote]"
- "[quote]"
```

Include this format in the summarization prompt as a required output template.

---

## Frontend Requirements

### Must-haves
- **Mobile-first responsive design.** No horizontal scrolling. Text and buttons must be comfortably tappable on a phone screen. Use `max-width` containers and `rem`-based sizing.
- **Two views:** a login page (`index.html`) and the main tool (`app.html`). The server serves `app.html` only to authenticated requests.
- **Single input field** for the YouTube URL, a submit button, and a results area where Markdown output renders formatted (use a lightweight Markdown renderer like `marked.js` — CDN is fine).
- Loading state while the transcript is being fetched and summarized. The combined operation can take 10–30 seconds for long videos; show a spinner or progress message.
- Error states: invalid URL (red inline message), transcript unavailable, AI error. All user-facing, no raw stack traces.

### Nice-to-haves (implement if straightforward, skip if not)
- Copy-to-clipboard button on the output.
- Character/word count of the transcript before summarization.
- A toggle to switch between AI providers if both are configured.

---

## Transcript Fetching Notes

Use the `youtube-transcript` package. Some videos will not have transcripts (disabled by creator, or not yet auto-generated). Handle this gracefully:
- Catch the error from the package.
- Return a user-facing message: "This video doesn't have a transcript available. Try a different video."

Do not attempt to fall back to audio transcription — that's out of scope.

---

## Railway Deployment Notes

- Railway auto-detects Node.js. Ensure `package.json` has a `"start": "node server.js"` script.
- Railway injects `PORT` automatically — use `process.env.PORT || 3000` in `server.js`.
- Set all `.env` values in Railway's **Variables** tab (not in a committed file).
- Railway free plan has a sleep timeout on inactivity. The app will cold-start in a few seconds — acceptable for a personal tool.
- The GitHub repo should have a `.gitignore` that excludes `.env` and `node_modules/`.

---

## Security Summary (quick reference)

| Concern | Mitigation |
|---|---|
| Brute-force login | `express-rate-limit` on POST /login — 3 req / 3 hours / IP |
| Session theft | `httpOnly` + `Secure` + `SameSite=Strict` JWT cookie |
| Token longevity | 30-day expiry (configurable via `SESSION_DAYS`) |
| Prompt injection via URL | Server-side domain whitelist; URL rejected before reaching AI |
| Prompt injection via transcript content | Transcript wrapped in labeled XML tags; system prompt scoped tightly |
| Secret exposure | All secrets in env vars; `.env` gitignored; Railway vars encrypted at rest |
| Raw error exposure | All errors caught and returned as generic user-facing messages |

---

## Open Questions / Clarifications Needed

Before starting a full implementation, Claude Code may need answers to the following:

1. **`server.js` reference file** — You mentioned you'll provide a `server.js` showing your preferred auth setup. Please share that before starting auth implementation.
	1A: server.js file will be provided
2. **AI provider preference** — Which do you want as the default? Anthropic (Claude) or OpenAI (GPT-4o)?
	2A: Claude
3. **Summary length preference** — Should the Detailed Summary aim for a specific length (e.g., ~300 words, ~500 words), or let the AI judge based on video length?
	3A: AI can decide the summary length but regardless of length it should be quickly readable in a 5 minutes (this is just a number I'm making up) or less regardless of length.
4. **Token/cost guard** — Very long videos (3+ hours) produce massive transcripts that can hit token limits or generate large API bills. Should we truncate transcripts above a certain length, chunk and summarize, or warn the user?
	4A: We'll stick to the regular Sonnet here (I don't even think this is done in the code, I think that's done in the API). Since I'm the only one using it, it's not necessary to put a cap on it but JUST IN CASE, if the video is over 1 hour long, please specify the length explicitely and give a warning with a prompt asking me if I'm sure I want to continue with this very large query and doing it anyway if I allow it -- for this particular prompt, do not allow me to quickly press any buttons, give it like 3 seconds before it allows a response just in case I quickly press a button i didn't mean to press
5. **Markdown rendering** — Is rendering the output as formatted Markdown in the browser sufficient, or do you also want a "raw Markdown" copy option?
	5A: Convert to actual HTML so we see the real bold header and bullet points that look like bullet points rather than the RAW text. Keep in mind this is supposed to be readable in mobile too so keep that in mind.
---

*Last updated: June 2026*
