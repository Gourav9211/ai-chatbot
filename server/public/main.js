const messagesEl = document.getElementById('messages');
const form = document.getElementById('chatForm');
const input = document.getElementById('messageInput');
const newChatBtn = document.getElementById('newChatBtn');
const headerNewChatBtn = document.getElementById('headerNewChatBtn');
const stopBtn = document.getElementById('stopBtn');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const attachmentsBar = document.getElementById('attachmentsBar');
const overlay = document.getElementById('warningOverlay');
const acceptWarningBtn = document.getElementById('acceptWarningBtn');

// Login overlay elements
const loginOverlay = document.getElementById('loginOverlay');
const loginId = document.getElementById('loginId');
const loginPassword = document.getElementById('loginPassword');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');
const togglePw = document.getElementById('togglePw');
const rememberMe = document.getElementById('rememberMe');

// History elements
const historyListEl = document.getElementById('historyList');
const historyEmptyEl = document.getElementById('historyEmpty');

let currentController = null;
let queuedImages = [];
// Added missing state arrays used by history/new chat flows
let activeMessages = [];
let conversations = [];

// Autosize textarea
function autosize() {
  try {
    input.style.height = 'auto';
    const h = Math.min(input.scrollHeight || 0, 200);
    input.style.height = (h || 48) + 'px';
  } catch (_) {}
}
input?.addEventListener('input', autosize);
autosize();

// Guided options for Chandigarh University support (sample)
const CU_QUICK_REPLIES = [
  'Admissions & Eligibility',
  'Fees & Scholarships',
  'Programs & Curriculum',
  'Hostel & Facilities',
  'Exams & Results',
  'Placements & Internships',
  'Contact a Human Agent'
];

function loadConvos() {
  try {
    conversations = JSON.parse(localStorage.getItem('ai_chatbot_convos') || '[]');
  } catch {
    conversations = [];
  }
}
function saveConvos() {
  try { localStorage.setItem('ai_chatbot_convos', JSON.stringify(conversations)); } catch {}
}
function titleFrom(messages) {
  const first = messages.find(m => m.role === 'user');
  if (!first) return 'Conversation';
  const t = first.text.trim().replace(/\s+/g, ' ');
  return (t.length > 48 ? t.slice(0, 48) + '…' : t) || 'Conversation';
}
function renderHistory() {
  if (!historyListEl) return;
  historyListEl.innerHTML = '';
  if (!conversations.length) {
    historyEmptyEl?.classList.remove('hidden');
    return;
  }
  historyEmptyEl?.classList.add('hidden');
  conversations.slice().reverse().forEach((c) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const dot = document.createElement('div'); dot.className = 'h-dot';
    const title = document.createElement('div'); title.className = 'h-title'; title.textContent = c.title || 'Conversation';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'h-del';
    del.title = 'Delete conversation';
    del.setAttribute('aria-label', 'Delete conversation');
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 7h12m-9 0V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" stroke="#cbd1ff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!window.confirm('Delete this conversation?')) return;
      const idx = conversations.findIndex(x => x.id === c.id);
      if (idx > -1) {
        conversations.splice(idx, 1);
        saveConvos();
        renderHistory();
      }
    });

    item.appendChild(dot);
    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener('click', () => renderTranscript(c.messages || []));
    historyListEl.appendChild(item);
  });
}
function renderTranscript(msgs) {
  messagesEl.innerHTML = '';
  for (const m of msgs) {
    addMessage(m.role, m.text);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function saveCurrentConversationIfAny() {
  if (activeMessages.length >= 2) {
    const convo = { id: Date.now(), title: titleFrom(activeMessages), messages: activeMessages.slice(0) };
    conversations.push(convo);
    saveConvos();
    renderHistory();
  }
  activeMessages = [];
}

function addMessage(role, text) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message ' + (role === 'user' ? 'from-user' : 'from-bot');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'U' : 'A';

  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (role === 'user' ? ' user' : '');
  bubble.textContent = text;

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function setStreaming(v) {
  if (v) {
    stopBtn.disabled = false;
    sendBtn.disabled = true;
    sendBtn.classList.add('loading');
    input.disabled = true;
  } else {
    stopBtn.disabled = true;
    sendBtn.disabled = false;
    sendBtn.classList.remove('loading');
    input.disabled = false;
  }
}

// Enter to send, Shift+Enter newline
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function addAttachmentPreview(file, dataUrl) {
  const wrap = document.createElement('div');
  wrap.className = 'att';
  const img = document.createElement('img');
  img.className = 'thumb';
  img.src = dataUrl;
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = file.name;
  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.innerHTML = '×';
  remove.addEventListener('click', () => {
    queuedImages = queuedImages.filter(x => x.name !== file.name || x.size !== file.size);
    wrap.remove();
  });
  wrap.appendChild(img); wrap.appendChild(name); wrap.appendChild(remove);
  attachmentsBar.appendChild(wrap);
}

attachBtn?.addEventListener('click', () => fileInput?.click());
fileInput?.addEventListener('change', () => {
  const files = Array.from(fileInput.files || []);
  const maxSize = 1.5 * 1024 * 1024; // 1.5MB
  for (const f of files) {
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) continue;
    if (f.size > maxSize) { console.warn('Skipping large file', f.name); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = (dataUrl.split(',')[1] || '');
      queuedImages.push({ name: f.name, size: f.size, mimeType: f.type, data: base64 });
      addAttachmentPreview(f, dataUrl);
    };
    reader.readAsDataURL(f);
  }
  // reset input so same file change can retrigger
  fileInput.value = '';
});

async function streamChat(message) {
  currentController = new AbortController();
  setStreaming(true);
  const payload = { message };
  if (queuedImages.length) {
    payload.images = queuedImages.map(({ mimeType, data }) => ({ mimeType, data }));
  }
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: currentController.signal,
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    addMessage('model', `Error: ${resp.status} ${text}`);
    setStreaming(false);
    currentController = null;
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let assistantText = '';
  const bubble = addMessage('model', '');
  bubble.classList.add('typing');

  while (true) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    assistantText += chunk;
    bubble.textContent = assistantText;
    bubble.classList.toggle('typing', assistantText.length === 0);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  bubble.classList.remove('typing');

  if (assistantText.trim()) {
    activeMessages.push({ role: 'model', text: assistantText });
    const qr = extractQuickReplies(assistantText);
    if (qr.length) addQuickReplies(qr);
  }

  setStreaming(false);
  currentController = null;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && queuedImages.length === 0) return;
  if (text) {
    addMessage('user', text);
    activeMessages.push({ role: 'user', text });
  } else {
    addMessage('user', '[Sent images]');
    activeMessages.push({ role: 'user', text: '[Sent images]' });
  }
  input.value = '';
  autosize();
  await streamChat(text);
  attachmentsBar.innerHTML = '';
  queuedImages = [];
});

function bindNewChat(btn) {
  btn?.addEventListener('click', async () => {
    try {
      saveCurrentConversationIfAny();
      if (currentController) { currentController.abort(); }
      await fetch('/api/reset', { method: 'POST' });
      // Clear UI and local state
      messagesEl.innerHTML = '';
      attachmentsBar.innerHTML = '';
      queuedImages = [];
      input.value = '';
      autosize();
      addMessage('model', 'New chat started. How can I help you today?');
      // Reset active conversation state
      activeMessages = [];
    } catch (e) {
      console.error(e);
    } finally {
      setStreaming(false);
      currentController = null;
    }
  });
}

bindNewChat(newChatBtn);
bindNewChat(headerNewChatBtn);

stopBtn?.addEventListener('click', () => {
  if (currentController) {
    currentController.abort();
  }
});

// Suggestions
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    input.value = chip.getAttribute('data-text') || chip.textContent || '';
    autosize();
    input.focus();
  });
}

// Warning overlay show-once logic as a callable function
function showWarningOverlayOnce() {
  try {
    const k = 'ai_chatbot_demo_ack';
    if (sessionStorage.getItem(k) === '1') return;
    overlay?.classList.remove('hidden');
    acceptWarningBtn?.addEventListener('click', () => {
      sessionStorage.setItem(k, '1');
      overlay?.classList.add('hidden');
    }, { once: true });
  } catch (e) {}
}

// Login flow (demo/demo)
(function loginInit() {
  try {
    const lk = 'ai_chatbot_demo_login';
    const rememberKey = 'ai_chatbot_demo_remember';
    const savedId = localStorage.getItem(rememberKey);
    if (savedId) {
      loginId.value = savedId;
      rememberMe.checked = true;
    }
    const logged = sessionStorage.getItem(lk) === '1';
    if (logged) {
      loginOverlay?.classList.add('hidden');
      showWarningOverlayOnce();
    } else {
      loginOverlay?.classList.remove('hidden');
    }

    togglePw?.addEventListener('click', () => {
      const isPw = loginPassword.type === 'password';
      loginPassword.type = isPw ? 'text' : 'password';
      togglePw.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
    });

    loginBtn?.addEventListener('click', () => {
      const id = (loginId?.value || '').trim();
      const pw = (loginPassword?.value || '').trim();
      if (id === 'demo' && pw === 'demo') {
        sessionStorage.setItem(lk, '1');
        if (rememberMe?.checked) {
          localStorage.setItem(rememberKey, id);
        } else {
          localStorage.removeItem(rememberKey);
        }
        loginOverlay?.classList.add('hidden');
        showWarningOverlayOnce();
        loginError?.classList.add('hidden');
      } else {
        loginError?.classList.remove('hidden');
      }
    });
  } catch (e) {}
})();

// Load history on start and save on unload
loadConvos();
renderHistory();
window.addEventListener('beforeunload', () => {
  try { saveCurrentConversationIfAny(); } catch {}
});

// Greet on load
addMessage('model', 'Hello! I\'m your AI support agent. Ask me anything about your account, orders, or troubleshooting.');

// Quick replies feature
function addQuickReplies(choices) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message quick-replies-message from-bot';
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = 'A';
  const bubble = document.createElement('div'); bubble.className = 'bubble reply-choices';
  const row = document.createElement('div'); row.className = 'quick-replies';
  (choices || []).forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qr';
    btn.textContent = c;
    btn.addEventListener('click', () => {
      input.value = c;
      form.requestSubmit();
    });
    row.appendChild(btn);
  });
  bubble.appendChild(row);
  wrapper.appendChild(avatar); wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Extract quick replies from assistant text like: "Admissions | Fees | Hostel"
function extractQuickReplies(text) {
  try {
    if (!text) return [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.includes('|')) {
        const parts = line.split('|').map(s => s.trim()).filter(s => s);
        const cleaned = parts.filter(p => p.length > 0 && p.length <= 60);
        if (cleaned.length >= 2 && cleaned.length <= 6) return cleaned;
      }
    }
  } catch (_) {}
  return [];
}

// On first load, seed a CU-specific welcome + quick replies
function showWelcome() {
  messagesEl.innerHTML = '';
  addMessage('model', "Hello! I'm the Chandigarh University support assistant. How can I help you today?");
  addQuickReplies(CU_QUICK_REPLIES);
}

// Replace greeting with CU welcome on first login only
(function initWelcomeOnce(){
  try {
    const k = 'ai_chatbot_welcome_cu';
    if (sessionStorage.getItem(k) === '1') return;
    sessionStorage.setItem(k, '1');
    showWelcome();
  } catch (e) {}
})();
