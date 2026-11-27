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
  if (!md || !md.trim()) return '<p class="status">No notes yet. Pick a style above and tap Rewrite.</p>';
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

const BRAND = 'Tiger Note Taker';
const brandEl = document.getElementById('brand');

// Home shows the Tiger Note Taker mark + name; other screens show a title with a back button.
function setChrome({ title, back }) {
  const isHome = title === BRAND;
  brandEl.hidden = !isHome;
  titleEl.hidden = isHome;
  titleEl.textContent = isHome ? '' : title;
  document.title = isHome ? BRAND : `${title} · ${BRAND}`;
  backBtn.hidden = !back;
}

backBtn.addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.hash = '#/';
});

/* ---------- Home: meeting list ---------- */
let searchTimer;
async function home() {
  setChrome({ title: BRAND, back: false });
  view.innerHTML = `
    <h2 class="page-title">Meetings</h2>
    <div class="search">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Search meetings" aria-label="Search meetings" enterkeyhint="search">
    </div>
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
                <span class="chip">${fmtDate(m.created_at)}</span>
                <p>${esc((m.preview || '').replace(/[#*\-]/g, '').trim())}</p></a></li>`,
            )
            .join('')
        : `<li class="empty"><i class="mark" aria-hidden="true"></i><span>${q.value ? 'No matches.' : 'No meetings yet. Tap Record to start.'}</span></li>`;
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
    const words = m.transcript.trim().split(/\s+/).length;
    view.innerHTML = `
      <div class="chips">
        <span class="chip">${fmtDate(m.created_at)}</span>
        <span class="chip">${words.toLocaleString()} words</span>
        <span class="chip">~${Math.max(1, Math.round(words / 150))} min</span>
      </div>
      <div class="seg" role="group" aria-label="View">
        <button type="button" data-v="notes" aria-pressed="true">Notes</button>
        <button type="button" data-v="transcript" aria-pressed="false">Transcript</button>
      </div>
      <div id="restyle" class="restyle">
        <label class="field inline"><span>Rewrite notes as</span>
          <select id="style">
            <option value="standard">Standard</option>
            <option value="brief">Brief</option>
            <option value="detailed">Detailed</option>
            <option value="actions">Action items only</option>
          </select>
        </label>
        <button class="btn" id="regen" type="button">Rewrite</button>
      </div>
      <div id="body" class="prose">${renderNotes(m.notes)}</div>

      <section class="group">
        <h3>Ask about this meeting</h3>
        <form id="askform" class="ask">
          <input id="q" type="text" placeholder="e.g. What did we decide about launch?" autocomplete="off" enterkeyhint="send" maxlength="500">
          <button class="btn primary" type="submit">Ask</button>
        </form>
        <div id="answers" class="answers"></div>
      </section>

      <div class="actions">
        <button class="btn" id="copy" type="button">Copy</button>
        <button class="btn" id="share" type="button">Share / Save</button>
        <button class="btn" id="rename" type="button">Rename</button>
        <button class="btn danger" id="del" type="button">Delete</button>
      </div>`;
    let current = 'notes';
    const body = document.getElementById('body');
    const restyle = document.getElementById('restyle');
    const draw = () => {
      restyle.hidden = current !== 'notes';
      if (current === 'notes') { body.className = 'prose'; body.innerHTML = renderNotes(m.notes); }
      else { body.className = 'prose transcript'; body.textContent = m.transcript; }
    };
    view.querySelectorAll('.seg button').forEach((b) =>
      b.addEventListener('click', () => {
        current = b.dataset.v;
        view.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        draw();
      }),
    );

    const regen = document.getElementById('regen');
    regen.addEventListener('click', async () => {
      regen.disabled = true; regen.textContent = 'Writing…';
      try {
        const r = await api(`/api/meetings/${encodeURIComponent(id)}/regenerate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ style: document.getElementById('style').value }),
        });
        m.notes = r.notes; draw();
      } catch (e) { alert(e.message); }
      regen.disabled = false; regen.textContent = 'Rewrite';
    });

    document.getElementById('askform').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = document.getElementById('q');
      const question = input.value.trim();
      if (!question) return;
      const answers = document.getElementById('answers');
      const item = document.createElement('div');
      item.className = 'qa';
      item.innerHTML = `<p class="q">${esc(question)}</p><p class="a">Thinking…</p>`;
      answers.prepend(item);
      input.value = '';
      try {
        const r = await api(`/api/meetings/${encodeURIComponent(id)}/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question }),
        });
        item.querySelector('.a').textContent = r.answer;
      } catch (e) {
        item.querySelector('.a').textContent = e.message;
        item.querySelector('.a').classList.add('error');
      }
    });

    const asText = () => `# ${m.title}\n${fmtDate(m.created_at)}\n\n${m.notes}\n\n## Transcript\n\n${m.transcript}\n`;
    document.getElementById('copy').addEventListener('click', async (ev) => {
      const text = current === 'notes' ? m.notes : m.transcript;
      try { await navigator.clipboard.writeText(text); ev.target.textContent = 'Copied'; }
      catch { ev.target.textContent = 'Copy failed'; }
      setTimeout(() => (ev.target.textContent = 'Copy'), 1500);
    });
    document.getElementById('share').addEventListener('click', async () => {
      const file = new File([asText()], `${m.title.replace(/[^\w\- ]+/g, '').trim() || 'meeting'}.md`, { type: 'text/markdown' });
      try {
        if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: m.title });
        else if (navigator.share) await navigator.share({ title: m.title, text: asText() });
        else {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(file); a.download = file.name; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }
      } catch { /* user cancelled the share sheet */ }
    });
    document.getElementById('rename').addEventListener('click', async () => {
      const title = prompt('Meeting title', m.title)?.trim();
      if (!title || title === m.title) return;
      try {
        await api(`/api/meetings/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        m.title = title; setChrome({ title, back: true });
      } catch (e) { alert(e.message); }
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
        ? `<div id="stage" class="stage"><button id="rec" class="rec-btn" type="button" aria-label="Start recording">
             <svg class="ico-mic" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
             <svg class="ico-stop" viewBox="0 0 24 24" width="44" height="44" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3"/></svg>
           </button></div>
           <div id="timer" class="timer" aria-live="off">0:00</div>
           <button id="pause" class="btn" type="button" hidden>
             <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>
             <span>Pause</span>
           </button>`
        : '<p class="status error">Recording isn\'t supported in this browser. Upload a file instead.</p>'}
      <div id="status" class="status"></div>
      <div id="live" class="live-text" hidden></div>
      <label class="field"><span>Notes style</span>
        <select id="style">
          <option value="standard">Standard: summary, points, actions</option>
          <option value="brief">Brief: quick summary</option>
          <option value="detailed">Detailed: full minutes</option>
          <option value="actions">Action items only</option>
        </select>
      </label>
      <div class="divider">or</div>
      <label class="btn block" for="file">Upload an audio file</label>
      <input id="file" type="file" accept="audio/*" hidden>
    </div>`;

  const statusEl = document.getElementById('status');
  const liveEl = document.getElementById('live');
  const recBtn = document.getElementById('rec');
  const stage = document.getElementById('stage');
  const timerEl = document.getElementById('timer');
  const fileInput = document.getElementById('file');
  const styleSel = document.getElementById('style');
  const pauseBtn = document.getElementById('pause');

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
      body: JSON.stringify({ transcript, style: styleSel.value }),
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
  let runStart = 0; // when the current un-paused stretch began
  let elapsedBefore = 0; // seconds recorded before the current stretch
  let recording = false;
  let paused = false;
  let queue = Promise.resolve();
  let queueError = null;

  const mime = pickMime();

  // Live mic level drives the pulsing ring behind the record button.
  let audioCtx, meterRaf;
  function startMeter() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let level = 0;
      const frame = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        level += (Math.min(peak / 64, 1) - level) * 0.25;
        stage.style.setProperty('--level', level.toFixed(3));
        meterRaf = requestAnimationFrame(frame);
      };
      frame();
    } catch { /* the ring is decorative */ }
  }
  function stopMeter() {
    cancelAnimationFrame(meterRaf);
    stage.style.removeProperty('--level');
    audioCtx?.close().catch(() => {});
  }

  function startSegment() {
    const chunks = [];
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || mime });
      if (blob.size > 0) {
        queue = queue.then(() => transcribeBlob(blob)).catch((e) => { queueError = e; });
      }
      if (recording && !paused) startSegment();
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
    paused = false;
    elapsedBefore = 0;
    runStart = Date.now();
    pauseBtn.hidden = false;
    recBtn.setAttribute('aria-label', 'Stop recording');
    recBtn.classList.add('live');
    stage.classList.add('live');
    startMeter();
    setStatus('Recording. Keep this screen open.');
    tick = setInterval(renderTimer, 500);
    startSegment();
  }

  function renderTimer() {
    const s = Math.floor(elapsedBefore + (paused ? 0 : (Date.now() - runStart) / 1000));
    timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  const setPauseLabel = (label, icon) => {
    pauseBtn.querySelector('span').textContent = label;
    pauseBtn.querySelector('svg').innerHTML = icon;
  };

  // Pause closes the current segment (so its audio is transcribed right away) and stops the clock.
  function pause() {
    if (!recording || paused) return;
    paused = true;
    elapsedBefore += (Date.now() - runStart) / 1000;
    clearTimeout(segTimer);
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getAudioTracks().forEach((t) => (t.enabled = false));
    stage.classList.remove('live');
    stage.style.setProperty('--level', '0');
    setPauseLabel('Resume', '<path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.5-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5Z"/>');
    setStatus('Paused. Tap Resume to keep going.');
    renderTimer();
  }

  function resume() {
    if (!recording || !paused) return;
    paused = false;
    runStart = Date.now();
    stream.getAudioTracks().forEach((t) => (t.enabled = true));
    stage.classList.add('live');
    setPauseLabel('Pause', '<rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/>');
    setStatus('Recording. Keep this screen open.');
    startSegment();
  }

  pauseBtn.addEventListener('click', () => (paused ? resume() : pause()));

  async function stop() {
    recording = false;
    clearTimeout(segTimer);
    clearInterval(tick);
    recBtn.disabled = true;
    pauseBtn.hidden = true;
    paused = false;
    recBtn.classList.remove('live');
    stage.classList.remove('live');
    stopMeter();
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
      recBtn.setAttribute('aria-label', 'Start recording');
    }
  }

  recBtn.addEventListener('click', () => (recording ? stop() : start()));
}

/* ---------- Settings + theme ---------- */
const themeMeta = document.querySelector('meta[name="theme-color"]');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function savedTheme() {
  try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
}

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
  else delete root.dataset.theme;
  try { choice === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', choice); } catch { /* storage may be blocked */ }
  const dark = choice === 'dark' || (choice === 'system' && darkQuery.matches);
  themeMeta.setAttribute('content', dark ? '#0e1424' : '#ffffff');
}

darkQuery.addEventListener('change', () => applyTheme(savedTheme()));
applyTheme(savedTheme());

function settings() {
  setChrome({ title: BRAND, back: false });
  const current = savedTheme();
  const opt = (v, label) => `<button type="button" data-theme="${v}" aria-pressed="${current === v}">${label}</button>`;
  view.innerHTML = `
    <h2 class="page-title">Settings</h2>
    <section class="group">
      <h3>Appearance</h3>
      <div class="seg" role="group" aria-label="Theme">
        ${opt('system', 'System')}${opt('light', 'Light')}${opt('dark', 'Dark')}
      </div>
    </section>
    <section class="group">
      <h3>About</h3>
      <div class="about"><i class="mark" aria-hidden="true"></i>
        <div><strong>${BRAND}</strong><span>Record a meeting and get a transcript and notes.</span></div></div>
    </section>`;
  view.querySelectorAll('[data-theme]').forEach((b) =>
    b.addEventListener('click', () => {
      applyTheme(b.dataset.theme);
      view.querySelectorAll('[data-theme]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }),
  );
}

/* ---------- Router ---------- */
function router() {
  const hash = location.hash || '#/';
  const detailMatch = hash.match(/^#\/m\/([\w-]+)$/);
  tabs.forEach((a) => {
    const page = hash === '#/new' ? 'new' : hash === '#/settings' ? 'settings' : 'home';
    const active = a.dataset.tab === page;
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (detailMatch) detail(detailMatch[1]);
  else if (hash === '#/new') newMeeting();
  else if (hash === '#/settings') settings();
  else home();
}

window.addEventListener('hashchange', router);
router();
