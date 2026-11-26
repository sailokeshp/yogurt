# Yogurt Web

A mobile-first web version of Yogurt that runs on Cloudflare. Record or upload a
meeting in your phone's browser, get a transcript from Whisper and notes from
Gemma 4, and keep everything searchable.

- **Frontend:** static HTML/CSS/JS in `public/` (no build step), served by Workers static assets
- **API:** a single Worker in `src/index.ts`
- **Models (Workers AI):** `@cf/openai/whisper-large-v3-turbo` for transcription and
  `@cf/google/gemma-4-26b-a4b-it` for notes. Change them in `wrangler.jsonc` under `vars`.
- **Storage:** D1 (`meetings` table)

This is a separate app from the desktop Yogurt in `../app`. It does not run models
on your device. Audio is sent to Cloudflare for processing.

## Run it

The D1 database `yogurt` already exists in the Cloudflare account (its id is in
`wrangler.jsonc`) and the `meetings` table is created. If you deploy to a different
account, run `npx wrangler d1 create yogurt`, paste the new id into `wrangler.jsonc`,
then `npm run db:init:remote`.

```sh
cd web
npm install
npx wrangler login
npm run deploy
```

For local development use `npm run db:init` then `npm run dev`. Workers AI calls
always go to Cloudflare, even in local dev, so you need to be logged in.

## Limits to know about

- Workers AI free plan: 10,000 Neurons per day. When it runs out the API returns a
  429 and the UI shows a message. The paid Workers plan lifts the cap.
- Each audio upload is limited to 20 MB. While recording, the app cuts the audio into
  90 second segments and transcribes them as you go.
- Keep the screen on while recording. Mobile browsers pause background tabs.
- There is **no login**. Anyone with the URL can read and delete meetings. Put the
  Worker behind Cloudflare Access before sharing the URL.
