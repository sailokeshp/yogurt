const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');
const tabs = document.querySelectorAll('.tabs a');

const SEGMENT_MS = 90_000; // restart the recorder so every segment is a standalone file
const MAX_UPLOAD = 20 * 1024 * 1024;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (ms) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Tiny, safe Markdown: escape first, then handle headings and bullets only.
function renderNotes(md) {
  const lines = esc(md).split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${bullet[1].replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) html += `<h2>${h[1]}</h2>`;
    else if (line) html += `<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function setChrome({ title, back }) {
  titleEl.textContent = title;
  document.title = title === 'Yogurt' ? 'Yogurt' : `${title} · Yogurt`;
  backBtn.hidden = !back;
}

backBtn.addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.hash = '#/';
});

/* ---------- Home: meeting list ---------- */
let searchTimer;
async function home() {
  setChrome({ title: 'Yogurt', back: false });
  view.innerHTML = `
    <input id="q" type="search" placeholder="Search meetings" aria-label="Search meetings" enterkeyhint="search">
    <ul id="list" class="list"></ul>`;
  const list = document.getElementById('list');
  const q = document.getElementById('q');

  async function load() {
    try {
      const meetings = await api(`/api/meetings?q=${encodeURIComponent(q.value)}`);
      list.innerHTML = meetings.length
        ? meetings
            .map(
              (m) => `<li><a class="card" href="#/m/${esc(m.id)}">
                <h2>${esc(m.title)}</h2>
                <span class="meta">${fmtDate(m.created_at)}</span>
                <p>${esc((m.preview || '').replace(/[#*\-]/g, '').trim())}</p></a></li>`,
            )
            .join('')
        : `<li class="empty">${q.value ? 'No matches.' : 'No meetings yet. Tap Record to start.'}</li>`;
    } catch (e) {
      list.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
    }
  }
  q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 250);
  });
  load();
}

/* ---------- Meeting detail ---------- */
async function detail(id) {
  setChrome({ title: 'Meeting', back: true });
  view.innerHTML = '<p class="status">Loading…</p>';
  try {
    const m = await api(`/api/meetings/${encodeURIComponent(id)}`);
    setChrome({ title: m.title, back: true });
    view.innerHTML = `
      <p class="meta">${fmtDate(m.created_at)}</p>
      <div class="seg" role="group" aria-label="View">
        <button type="button" data-v="notes" aria-pressed="true">Notes</button>
        <button type="button" data-v="transcript" aria-pressed="false">Transcript</button>
      </div>
      <div id="body" class="prose">${renderNotes(m.notes)}</div>
      <div class="actions">
        <button class="btn" id="copy" type="button">Copy</button>
        <button class="btn danger" id="del" type="button">Delete</button>
      </div>`;
    let current = 'notes';
    const body = document.getElementById('body');
    view.querySelectorAll('.seg button').forEach((b) =>
      b.addEventListener('click', () => {
        current = b.dataset.v;
        view.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        if (current === 'notes') { body.className = 'prose'; body.innerHTML = renderNotes(m.notes); }
        else { body.className = 'prose transcript'; body.textContent = m.transcript; }
      }),
    );
    document.getElementById('copy').addEventListener('click', async (ev) => {
      const text = current === 'notes' ? m.notes : m.transcript;
      try { await navigator.clipboard.writeText(text); ev.target.textContent = 'Copied'; }
      catch { ev.target.textContent = 'Copy failed'; }
      setTimeout(() => (ev.target.textContent = 'Copy'), 1500);
    });
    document.getElementById('del').addEventListener('click', async () => {
      if (!confirm('Delete this meeting?')) return;
      await api(`/api/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' });
      location.hash = '#/';
    });
  } catch (e) {
    view.innerHTML = `<p class="status error">${esc(e.message)}</p>`;
  }
}

/* ---------- Record / upload ---------- */
function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return options.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function newMeeting() {
  setChrome({ title: 'New meeting', back: false });
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  view.innerHTML = `
    <div class="recorder">
      ${canRecord
        ? `<button id="rec" class="rec-btn" type="button">Record</button>
           <div id="timer" class="timer" aria-live="off">0:00</div>`
        : '<p class="status error">Recording isn\'t supported in this browser. Upload a file instead.</p>'}
      <div id="status" class="status"></div>
      <div id="live" class="live-text" hidden></div>
      <div class="divider">or</div>
      <label class="btn block" for="file">Upload an audio file</label>
      <input id="file" type="file" accept="audio/*" hidden>
    </div>`;

  const statusEl = document.getElementById('status');
  const liveEl = document.getElementById('live');
  const recBtn = document.getElementById('rec');
  const timerEl = document.getElementById('timer');
  const fileInput = document.getElementById('file');

  const setStatus = (msg, isError = false) => {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', isError);
  };

  const parts = [];
  const showText = () => {
    liveEl.hidden = parts.length === 0;
    liveEl.textContent = parts.join(' ');
  };

  async function transcribeBlob(blob) {
    if (blob.size > MAX_UPLOAD) throw new Error('That file is over 20 MB. Try a shorter clip.');
    const { text } = await api('/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (text) { parts.push(text); showText(); }
  }

  async function finish() {
    const transcript = parts.join(' ').trim();
    if (!transcript) { setStatus('No speech was detected.', true); return; }
    setStatus('Writing notes…');
    const m = await api('/api/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    location.hash = `#/m/${m.id}`;
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      parts.length = 0;
      setStatus('Transcribing…');
      await transcribeBlob(file);
      await finish();
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      fileInput.value = '';
    }
  });

  if (!canRecord) return;

  let stream, recorder, segTimer, tick, wakeLock;
  let startedAt = 0;
  let recording = false;
  let queue = Promise.resolve();
  let queueError = null;

  const mime = pickMime();

  function startSegment() {
    const chunks = [];
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || mime });
      if (blob.size > 0) {
        queue = queue.then(() => transcribeBlob(blob)).catch((e) => { queueError = e; });
      }
      if (recording) startSegment();
    };
    recorder.start();
    segTimer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), SEGMENT_MS);
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus('Microphone access was blocked. Allow it in your browser settings.', true);
      return;
    }
    parts.length = 0;
    queueError = null;
    recording = true;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    startedAt = Date.now();
    recBtn.textContent = 'Stop';
    recBtn.classList.add('live');
    setStatus('Recording. Keep this screen open.');
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    startSegment();
  }

  async function stop() {
    recording = false;
    clearTimeout(segTimer);
    clearInterval(tick);
    recBtn.disabled = true;
    recBtn.classList.remove('live');
    recBtn.textContent = '…';
    setStatus('Transcribing…');
    await new Promise((resolve) => {
      const r = recorder;
      const prev = r.onstop;
      r.onstop = (e) => { prev(e); resolve(); };
      if (r.state !== 'inactive') r.stop(); else resolve();
    });
    stream.getTracks().forEach((t) => t.stop());
    try { await wakeLock?.release(); } catch { /* ignore */ }
    try {
      await queue;
      if (queueError && parts.length === 0) throw queueError;
      await finish();
    } catch (e) {
      setStatus(e.message, true);
      recBtn.disabled = false;
      recBtn.textContent = 'Record';
    }
  }

  recBtn.addEventListener('click', () => (recording ? stop() : start()));
}

/* ---------- Router ---------- */
function router() {
  const hash = location.hash || '#/';
  const detailMatch = hash.match(/^#\/m\/([\w-]+)$/);
  tabs.forEach((a) => {
    const active = (a.dataset.tab === 'new' && hash === '#/new') || (a.dataset.tab === 'home' && hash !== '#/new');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (detailMatch) detail(detailMatch[1]);
  else if (hash === '#/new') newMeeting();
  else home();
}

window.addEventListener('hashchange', router);
router();
