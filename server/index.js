import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
let GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
const SUPPORT_PERSONA = (process.env.SUPPORT_PERSONA || `
You are SupportBot, a helpful, professional customer support agent for Chandigarh University (CU).
- Maintain a friendly, concise support tone tailored to prospective and current CU students and parents.
- Topics include admissions & eligibility, fees & scholarships, programs, hostel/facilities, exams/results, placements, and connecting with a human agent.
- Ask for relevant details (e.g., application number, department, program, semester) when needed.
- Do not invent policies; if unsure, provide generic guidance and suggest contacting CU official support.
- When helpful, end with up to 3 short, clickable suggestion options separated by a pipe character (e.g., Admissions | Fees | Hostel).
`).trim();

function normalizeModelName(name = '') {
  let n = (name || '').trim();
  if (n.startsWith('models/')) n = n.slice('models/'.length);
  if (n === 'gemini-2.5-flash' || n === 'gemini-2.5-flash-latest') return 'gemini-2.5-flash';
  if (n === 'gemini-1.5-flash' ) return 'gemini-1.5-flash-latest';
  if (n === 'gemini-1.5-pro' ) return 'gemini-1.5-pro-latest';
  return n || 'gemini-1.5-flash-latest';
}
GEMINI_MODEL = normalizeModelName(GEMINI_MODEL);

if (!GEMINI_API_KEY) {
  console.warn('[warn] GEMINI_API_KEY is not set. Set it in your .env file.');
}

// Simple in-memory session store. For production, use a persistent store.
const sessions = new Map(); // sid -> { history: Array<{ role: 'user'|'model', text: string }>, createdAt: number }

app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
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

// Initialize Google AI client
const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY, apiEndpoint: 'https://generativelanguage.googleapis.com' });

function pickFallbackModel(models = []) {
  const names = models.map(m => m.name).filter(Boolean);
  const prefer = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro-latest',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ];
  for (const p of prefer) {
    const found = names.find(n => n.includes(p));
    if (found) return normalizeModelName(found);
  }
  return names[0] || normalizeModelName(GEMINI_MODEL);
}

async function streamWithSDK({ model, contents, generationConfig, onChunk }) {
  const mdl = normalizeModelName(model);
  const personaContent = SUPPORT_PERSONA ? [{ role: 'user', parts: [{ text: SUPPORT_PERSONA }] }] : [];
  const fullContents = [...personaContent, ...contents];

  // Try streaming first
  const result = await genAI.models.generateContentStream({
    model: mdl,
    contents: fullContents,
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      ...(generationConfig || {}),
    },
  });

  const iter = (result && typeof result.stream?.[Symbol.asyncIterator] === 'function')
    ? result.stream
    : (typeof result?.[Symbol.asyncIterator] === 'function' ? result : null);

  if (iter) {
    for await (const chunk of iter) {
      const t = chunk?.text
        ? (typeof chunk.text === 'function' ? chunk.text() : chunk.text)
        : (chunk?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '');
      if (t) onChunk(t);
    }
    return;
  }

  // Fallback to non-streaming once via SDK if stream not iterable
  const { response } = await genAI.models.generateContent({
    model: mdl,
    contents: fullContents,
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      ...(generationConfig || {}),
    },
  });
  const text = response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (text) onChunk(text);
}

function modelForApiVersion(version, name) {
  const n = normalizeModelName(name);
  if (version === 'v1') {
    if (n === 'gemini-1.5-flash-latest') return 'gemini-1.5-flash';
    if (n === 'gemini-1.5-pro-latest') return 'gemini-1.5-pro';
    return n; // gemini-2.5-flash stays as-is
  }
  return n; // v1beta accepts -latest variants
}

async function generateOnceHTTP({ model, contents, generationConfig }) {
  const personaContent = SUPPORT_PERSONA ? [{ role: 'user', parts: [{ text: SUPPORT_PERSONA }] }] : [];
  const body = {
    contents: [...personaContent, ...contents],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      ...(generationConfig || {}),
    },
  };

  const versions = ['v1', 'v1beta'];
  let lastErr;
  for (const ver of versions) {
    try {
      const mdl = modelForApiVersion(ver, model);
      const url = new URL(`https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(mdl)}:generateContent`);
      url.searchParams.set('key', GEMINI_API_KEY);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        const err = new Error(`Gemini API error: ${resp.status} ${resp.statusText} ${t}`);
        err.status = resp.status;
        throw err;
      }
      const json = await resp.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      return parts.map(p => p.text || '').join('');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function streamWithHTTP({ model, contents, generationConfig, onChunk }) {
  const personaContent = SUPPORT_PERSONA ? [{ role: 'user', parts: [{ text: SUPPORT_PERSONA }] }] : [];
  const body = {
    contents: [...personaContent, ...contents],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      ...(generationConfig || {}),
    },
  };

  // Try v1 then v1beta
  const versions = ['v1', 'v1beta'];
  let lastErr;
  for (const ver of versions) {
    try {
      const mdl = modelForApiVersion(ver, model);
      const url = new URL(`https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(mdl)}:streamGenerateContent`);
      url.searchParams.set('alt', 'sse');
      url.searchParams.set('key', GEMINI_API_KEY);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(() => '');
        const err = new Error(`Gemini API error: ${resp.status} ${resp.statusText} ${t}`);
        err.status = resp.status;
        throw err;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]') continue;
            try {
              const json = JSON.parse(dataStr);
              const candidate = json?.candidates?.[0];
              const parts = candidate?.content?.parts || candidate?.delta?.parts || [];
              for (const p of parts) {
                if (typeof p.text === 'string') onChunk(p.text);
              }
            } catch {}
          }
        }
      }
      return; // success
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { sid, session } = getOrCreateSession(req, res);
    const message = (req.body?.message || '').toString().trim();
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!message && images.length === 0) {
      return res.status(400).json({ error: 'Message or image is required' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured with GEMINI_API_KEY' });
    }

    const userParts = [];
    if (message) userParts.push({ text: message });
    for (const img of images) {
      if (img && typeof img.mimeType === 'string' && typeof img.data === 'string') {
        userParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
    }

    const contents = [
      ...historyToContents(session.history),
      { role: 'user', parts: userParts },
    ];

    const imgNote = images.length ? ` (attached ${images.length} image${images.length > 1 ? 's' : ''})` : '';
    if (message || images.length) session.history.push({ role: 'user', text: (message || 'User sent images') + imgNote });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    let fullText = '';
    let streamed = false;
    const onChunk = (c) => { streamed = true; fullText += c; res.write(c); };

    let modelToUse = GEMINI_MODEL;
    try {
      await streamWithSDK({ model: modelToUse, contents, onChunk });
    } catch (sdkErr) {
      console.warn('[sdk] falling back to HTTP:', sdkErr?.message || sdkErr);
      try {
        await streamWithHTTP({ model: modelToUse, contents, onChunk });
      } catch (httpErr) {
        try {
          const list = await genAI.models.list();
          const fallback = pickFallbackModel(list || []);
          if (fallback && fallback !== modelToUse) {
            console.warn(`[models] retrying with fallback model: ${fallback}`);
            modelToUse = fallback;
            await streamWithHTTP({ model: modelToUse, contents, onChunk });
          } else {
            throw httpErr;
          }
        } catch (finalErr) {
          console.warn('[final] streaming failed, trying non-streaming once:', finalErr?.message || finalErr);
          try {
            const txt = await generateOnceHTTP({ model: modelToUse, contents });
            if (txt) { fullText += txt; res.write(txt); streamed = true; }
          } catch (genErr) {
            throw genErr;
          }
        }
      }
    }

    if (!streamed) {
      const placeholder = 'I could not generate a response. Please try again.';
      fullText += placeholder;
      res.write(placeholder);
    }

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

app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Chatbot server running on http://localhost:${PORT}`);
});
