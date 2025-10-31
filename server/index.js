import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const SUPPORT_PERSONA = (process.env.SUPPORT_PERSONA || `
You are SupportBot, a helpful, professional customer support agent for our demo app.
- Always respond in a friendly, concise customer-support tone.
- Ask clarifying questions when details are missing (e.g., order ID, email on account).
- Provide step-by-step troubleshooting when relevant.
- If something is unknown or outside scope, say you don't have that information and suggest the next best step.
- Never make policy or pricing claims; instead, refer to "our policy" generically and suggest contacting a human if needed.
`).trim();

if (!GEMINI_API_KEY) {
  console.warn('[warn] GEMINI_API_KEY is not set. Set it in your .env file.');
}

// Simple in-memory session store. For production, use a persistent store.
const sessions = new Map(); // sid -> { history: Array<{ role: 'user'|'model', text: string }>, createdAt: number }

app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: ORIGIN,
    credentials: true,
  })
);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Helpers
function parseCookies(cookieHeader = '') {
  const out = {};
  cookieHeader.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`); else parts.push('Path=/');
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`); else parts.push('SameSite=Lax');
  if (opts.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function getOrCreateSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  let sid = cookies.sid;
  let session = sid && sessions.get(sid);
  if (!session) {
    sid = randomUUID();
    session = { history: [], createdAt: Date.now() };
    sessions.set(sid, session);
    setCookie(res, 'sid', sid, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: false, // set true if behind HTTPS
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
  }
  return { sid, session };
}

function historyToContents(history) {
  return history.map((h) => ({
    role: h.role,
    parts: [{ text: h.text }],
  }));
}

async function streamGemini({ model, apiKey, contents, generationConfig }) {
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent`);
  url.searchParams.set('alt', 'sse');
  url.searchParams.set('key', apiKey);

  const body = {
    systemInstruction: {
      parts: [{ text: SUPPORT_PERSONA }],
    },
    contents,
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      ...(generationConfig || {}),
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Gemini API error: ${resp.status} ${resp.statusText} ${text}`);
    err.status = resp.status;
    throw err;
  }

  return resp.body; // ReadableStream of SSE events
}

app.post('/api/chat', async (req, res) => {
  try {
    const { sid, session } = getOrCreateSession(req, res);
    const message = (req.body?.message || '').toString().trim();
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured with GEMINI_API_KEY' });
    }

    // Prepare contents with history + current user message
    const contents = [
      ...historyToContents(session.history),
      { role: 'user', parts: [{ text: message }] },
    ];

    // Optimistically add user message to history
    session.history.push({ role: 'user', text: message });

    // Start streaming response to client
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // for nginx

    let fullText = '';

    const sseStream = await streamGemini({
      model: GEMINI_MODEL,
      apiKey: GEMINI_API_KEY,
      contents,
    });

    const reader = sseStream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const flushText = (text) => {
      if (!text) return;
      res.write(text);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') {
            continue;
          }
          try {
            const json = JSON.parse(dataStr);
            // Typical shape: { candidates: [ { content: { parts: [{ text }] } } ] }
            const candidate = json?.candidates?.[0];
            const parts = candidate?.content?.parts || candidate?.delta?.parts || [];
            for (const p of parts) {
              if (typeof p.text === 'string') {
                fullText += p.text;
                flushText(p.text);
              }
            }
          } catch (e) {
            // Ignore parse errors for keep-alive/heartbeat lines
          }
        }
      }
    }

    // Save model response into history
    if (fullText.trim()) {
      session.history.push({ role: 'model', text: fullText });
    }

    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message || 'Unexpected error' });
    } else {
      res.write(`\n[Error: ${err.message || 'Unexpected error'}]`);
      res.end();
    }
  }
});

app.post('/api/reset', (req, res) => {
  const { sid } = getOrCreateSession(req, res);
  sessions.set(sid, { history: [], createdAt: Date.now() });
  res.json({ ok: true });
});

// Fallback to index.html for root
app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Chatbot server running on http://localhost:${PORT}`);
});
