import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ── Startup checks ────────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET)       console.warn('WARNING: JWT_SECRET not set');
if (!process.env.HASHED_PASSWORD)  console.warn('WARNING: HASHED_PASSWORD not set — login will always fail');

const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '30', 10);
const JWT_SECRET   = process.env.JWT_SECRET || 'dev-secret-change-me';
const AI_PROVIDER  = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();

// ── AI clients (lazy-loaded only when provider matches) ───────────────────────
let anthropic, openai;
if (AI_PROVIDER === 'anthropic') {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} else if (AI_PROVIDER === 'openai') {
  const { default: OpenAI } = await import('openai');
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  console.warn(`WARNING: Unknown AI_PROVIDER "${AI_PROVIDER}" — defaulting to anthropic`);
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

// ── Rate limiter ───────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 3 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in 3 hours.' },
});

// ── Auth helpers ───────────────────────────────────────────────────────────────
function signToken() {
  return jwt.sign({ auth: true }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/');
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token');
    res.redirect('/');
  }
}

function requireAuthApi(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token');
    res.status(401).json({ error: 'Session expired — please log in again.' });
  }
}

// ── Transcript fetching ────────────────────────────────────────────────────────

function extractVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
    return url.searchParams.get('v') || null;
  } catch { return null; }
}


const WATCH_PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchTranscript(videoId) {
  // Fetch the watch page — ytInitialPlayerResponse embedded in the HTML
  // contains caption tracks even when the InnerTube API withholds them for server IPs
  try {
    const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': WATCH_PAGE_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    console.log(`[watchpage] status: ${pageResp.status}`);
    if (!pageResp.ok) return null;

    const html = await pageResp.text();

    if (html.includes('class="g-recaptcha"')) {
      console.log('[watchpage] blocked by captcha');
      return null;
    }

    // Extract ytInitialPlayerResponse from inline script
    const marker = 'var ytInitialPlayerResponse = ';
    const start = html.indexOf(marker);
    if (start === -1) { console.log('[watchpage] ytInitialPlayerResponse not found'); return null; }

    let depth = 0, end = -1;
    for (let i = start + marker.length; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) { console.log('[watchpage] could not parse JSON boundary'); return null; }

    const playerResponse = JSON.parse(html.slice(start + marker.length, end + 1));
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    console.log('[watchpage] tracks:', tracks ? tracks.map(t => `${t.languageCode} kind=${t.kind}`) : 'none');
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    // Prefer manual English, then auto-generated English (kind=asr), then anything
    const track =
      tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
      tracks.find(t => t.languageCode === 'en') ||
      tracks[0];

    const jsonUrl = track.baseUrl + '&fmt=json3';
    const jsonResp = await fetch(jsonUrl, { headers: { 'User-Agent': WATCH_PAGE_UA } });
    console.log(`[watchpage] JSON status: ${jsonResp.status}`);
    if (!jsonResp.ok) return null;

    const data = await jsonResp.json();
    console.log('[watchpage] json keys:', Object.keys(data));
    console.log('[watchpage] events count:', data.events?.length ?? 'undefined');
    if (data.events?.length > 0) console.log('[watchpage] first event:', JSON.stringify(data.events[0]));

    const segments = (data.events || [])
      .filter(e => e.segs)
      .map(e => ({
        text: e.segs.map(s => s.utf8).join('').trim(),
        offset: e.tStartMs ?? 0,
        duration: e.dDurationMs ?? 0,
      }))
      .filter(s => s.text && s.text !== '\n');

    console.log(`[watchpage] segments: ${segments.length}`);
    return segments.length > 0 ? segments : null;
  } catch (err) {
    console.log('[watchpage] error:', err.message);
    return null;
  }
}

// ── URL validation ─────────────────────────────────────────────────────────────
const ALLOWED_YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

function isValidYouTubeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    if (!ALLOWED_YOUTUBE_HOSTS.includes(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// ── AI summarization ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a concise summarization assistant. You receive YouTube video transcripts and return a structured summary. Follow the output format exactly. Do not editorialize or add information not present in the transcript.`;

const OUTPUT_FORMAT = `
Return your summary in exactly this Markdown structure:

# Title
[video title or best inferred title from content]

## TLDR
[one to three sentence summary]

## Main Takeaways
- [takeaway]
- [takeaway]
- [takeaway]

## Detailed Summary
[paragraph-form summary — aim for readability within 5 minutes regardless of video length; be thorough but tight]

## Notable Quotes
- "[quote]"
- "[quote]"
- "[quote]"
`.trim();

async function summarize(transcriptText) {
  const userMessage = `Summarize the following transcript:\n\n<transcript>\n${transcriptText}\n</transcript>\n\n${OUTPUT_FORMAT}`;

  if (AI_PROVIDER === 'anthropic' || !openai) {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    return msg.content[0].text;
  } else {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    return completion.choices[0].message.content;
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────
// Login page (unauthenticated root)
app.get('/', (req, res) => {
  const token = req.cookies?.token;
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET);
      return res.redirect('/app');
    } catch {
      res.clearCookie('token');
    }
  }
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.post('/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  const hash = process.env.HASHED_PASSWORD;

  let valid = false;
  if (password && hash) {
    try { valid = await bcrypt.compare(password, hash); } catch { /* invalid hash format */ }
  }

  if (valid) {
    const token = signToken();
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    });
    return res.redirect('/app');
  }

  console.warn(`[${new Date().toISOString()}] Failed login attempt from ${req.ip}`);
  // Artificial delay to slow brute-force beyond what rate limiting alone provides
  await new Promise(r => setTimeout(r, 3000));
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/');
});

// Protected app
app.get('/app', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'app.html'));
});

// Transcript + summarize API
app.post('/api/summarize', requireAuthApi, async (req, res) => {
  const { url, confirmed } = req.body;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL.' });
  }

  // Fetch transcript
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL.' });

  const segments = await fetchTranscript(videoId);
  if (!segments) {
    return res.status(422).json({ error: "This video doesn't have a transcript available. Try a different video." });
  }

  const transcriptText = segments.map(s => s.text).join(' ');

  // Estimate video duration from transcript timestamps
  const lastSegment = segments[segments.length - 1];
  const durationSeconds = lastSegment ? (lastSegment.offset + lastSegment.duration) / 1000 : 0;
  const durationMinutes = Math.round(durationSeconds / 60);
  const isLong = durationMinutes > 60;

  if (isLong && !confirmed) {
    return res.status(202).json({
      requiresConfirmation: true,
      durationMinutes,
      message: `This video is approximately ${durationMinutes} minutes long. Summarizing it will send a very large amount of text to the AI API. Are you sure you want to continue?`,
    });
  }

  // Summarize
  let summary;
  try {
    summary = await summarize(transcriptText);
  } catch (err) {
    console.error('AI summarization error:', err?.message || err);
    return res.status(502).json({ error: 'The AI summarization service encountered an error. Please try again.' });
  }

  res.json({ summary, durationMinutes });
});

// Provider info (so frontend knows which is active)
app.get('/api/provider', requireAuthApi, (req, res) => {
  res.json({ provider: AI_PROVIDER });
});

// Static files — must come after API routes
app.use(express.static(join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => {
  console.log(`YTT running on port ${PORT} | AI provider: ${AI_PROVIDER}`);
});
