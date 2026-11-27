export interface Env {
  AI: Ai;
  DB: D1Database;
  ASSETS: Fetcher;
  WHISPER_MODEL: string;
  NOTES_MODEL: string;
}

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const CHUNK_CHARS = 24_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const fail = (status: number, message: string) => json({ error: message }, status);

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

// Workers AI chat models return either {response} or an OpenAI-style {choices}.
function chatText(result: unknown): string {
  const r = result as {
    response?: string;
    choices?: { message?: { content?: string | null } }[];
  };
  return (r.response ?? r.choices?.[0]?.message?.content ?? '').toString().trim();
}

async function chat(env: Env, system: string, user: string, maxTokens = 1500): Promise<string> {
  const result = await env.AI.run(env.NOTES_MODEL as keyof AiModels, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
  } as never);
  return chatText(result);
}

const FACTS = ' Only use facts from the transcript. Do not invent names, dates or numbers.';

const STYLES = {
  standard: {
    system:
      'You write concise meeting notes from a transcript. Use Markdown with these sections: ' +
      '"## Summary" (2-4 sentences), "## Key points" (bullets), "## Decisions" (bullets, omit if none), ' +
      '"## Action items" (bullets with owner if stated, omit if none).' + FACTS,
    maxTokens: 1500,
  },
  brief: {
    system:
      'Summarize the meeting in Markdown: a "## Summary" of at most 3 sentences, then "## Key points" with 3 to 5 short bullets.' + FACTS,
    maxTokens: 500,
  },
  detailed: {
    system:
      'You write thorough meeting minutes in Markdown with these sections: "## Summary", "## Topics discussed" ' +
      '(a "###" subheading per topic with bullets), "## Decisions", "## Action items" (owner and deadline if stated), ' +
      '"## Open questions". Omit a section if it has nothing.' + FACTS,
    maxTokens: 2500,
  },
  actions: {
    system:
      'Extract only the follow-ups in Markdown: "## Action items" (bullets, owner and deadline if stated) and ' +
      '"## Decisions" (bullets). Omit a section if empty. If there are none at all, say so in one line.' + FACTS,
    maxTokens: 700,
  },
} as const;

type Style = keyof typeof STYLES;
const asStyle = (v: unknown): Style => (typeof v === 'string' && v in STYLES ? (v as Style) : 'standard');

function splitTranscript(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_CHARS) {
    let cut = rest.lastIndexOf('. ', CHUNK_CHARS);
    if (cut < CHUNK_CHARS / 2) cut = CHUNK_CHARS;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

async function makeNotes(env: Env, transcript: string, style: Style = 'standard'): Promise<string> {
  const { system, maxTokens } = STYLES[style];
  const parts = splitTranscript(transcript);
  if (parts.length === 1) {
    return chat(env, system, `Transcript:\n\n${parts[0]}`, maxTokens);
  }
  const partials: string[] = [];
  for (const [i, part] of parts.entries()) {
    partials.push(
      await chat(
        env,
        'Summarize this section of a longer meeting transcript as short bullet points. Only use facts present.',
        `Section ${i + 1} of ${parts.length}:\n\n${part}`,
        800,
      ),
    );
  }
  return chat(env, system, `Section summaries of one meeting:\n\n${partials.join('\n\n')}`, maxTokens);
}

async function makeTitle(env: Env, transcript: string): Promise<string> {
  const title = await chat(
    env,
    'Reply with a meeting title of at most 6 words. No quotes, no punctuation at the end.',
    transcript.slice(0, 6000),
    24,
  );
  return title.replace(/^["'#\s]+|["'\s.]+$/g, '').slice(0, 80) || 'Untitled meeting';
}

async function transcribe(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_AUDIO_BYTES) {
    return fail(413, 'Audio is too large. Keep each upload under 20 MB.');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return fail(400, 'No audio received.');
  if (bytes.length > MAX_AUDIO_BYTES) {
    return fail(413, 'Audio is too large. Keep each upload under 20 MB.');
  }
  const result = (await env.AI.run(env.WHISPER_MODEL as keyof AiModels, {
    audio: toBase64(bytes),
  } as never)) as { text?: string };
  return json({ text: (result.text ?? '').trim() });
}

async function createMeeting(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    transcript?: string;
    title?: string;
    style?: string;
  } | null;
  const transcript = body?.transcript?.trim();
  if (!transcript) return fail(400, 'Transcript is required.');

  const [notes, title] = await Promise.all([
    makeNotes(env, transcript, asStyle(body?.style)),
    body?.title?.trim() ? Promise.resolve(body.title.trim()) : makeTitle(env, transcript),
  ]);
  const meeting = { id: crypto.randomUUID(), title, transcript, notes, created_at: Date.now() };
  await env.DB.prepare(
    'INSERT INTO meetings (id, title, transcript, notes, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(meeting.id, meeting.title, meeting.transcript, meeting.notes, meeting.created_at)
    .run();
  return json(meeting, 201);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/transcribe' && method === 'POST') return transcribe(request, env);
  if (path === '/api/meetings' && method === 'POST') return createMeeting(request, env);

  if (path === '/api/meetings' && method === 'GET') {
    const q = url.searchParams.get('q')?.trim();
    const like = `%${q?.replace(/[%_]/g, '') ?? ''}%`;
    const { results } = await env.DB.prepare(
      'SELECT id, title, created_at, substr(notes, 1, 160) AS preview FROM meetings ' +
        'WHERE ?1 = \'%%\' OR title LIKE ?1 OR transcript LIKE ?1 OR notes LIKE ?1 ' +
        'ORDER BY created_at DESC LIMIT 100',
    )
      .bind(like)
      .all();
    return json(results);
  }

  const action = path.match(/^\/api\/meetings\/([\w-]+)\/(ask|regenerate)$/);
  if (action && method === 'POST') {
    const row = await env.DB.prepare('SELECT transcript FROM meetings WHERE id = ?')
      .bind(action[1])
      .first<{ transcript: string }>();
    if (!row) return fail(404, 'Meeting not found.');
    const body = (await request.json().catch(() => ({}))) as { question?: string; style?: string };

    if (action[2] === 'ask') {
      const question = body.question?.trim().slice(0, 500);
      if (!question) return fail(400, 'Question is required.');
      const answer = await chat(
        env,
        'Answer the question using only the meeting transcript below. Be brief and direct. ' +
          'If the transcript does not contain the answer, say you cannot find it in this meeting.',
        `Transcript:\n\n${row.transcript.slice(0, 120_000)}\n\nQuestion: ${question}`,
        600,
      );
      return json({ answer: answer || 'No answer was produced.' });
    }

    const notes = await makeNotes(env, row.transcript, asStyle(body.style));
    await env.DB.prepare('UPDATE meetings SET notes = ? WHERE id = ?').bind(notes, action[1]).run();
    return json({ notes });
  }

  const match = path.match(/^\/api\/meetings\/([\w-]+)$/);
  if (match) {
    const id = match[1];
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(id).first();
      return row ? json(row) : fail(404, 'Meeting not found.');
    }
    if (method === 'PATCH') {
      const body = (await request.json().catch(() => null)) as { title?: string } | null;
      const title = body?.title?.trim().slice(0, 80);
      if (!title) return fail(400, 'Title is required.');
      await env.DB.prepare('UPDATE meetings SET title = ? WHERE id = ?').bind(title, id).run();
      return json({ title });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM meetings WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  return fail(404, 'Not found.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error.';
      // Workers AI returns 3036 once the free daily Neuron allowance is used up.
      if (/3036|daily free allocation/i.test(message)) {
        return fail(429, 'Daily free AI allowance used up. Try again after 00:00 UTC.');
      }
      console.error(message);
      return fail(500, 'Something went wrong. Please try again.');
    }
  },
} satisfies ExportedHandler<Env>;
