#!/usr/bin/env bun
// ─── Phase 0: watch what the real web client actually does ────────────────────
//
// The reference clients in the research are a November-2024 snapshot, and at
// least one of their core endpoints (`identity/profiles/{id}/profileView`) now
// returns 410 Gone. Guessing at replacements is how you end up shipping a
// Chrome-83 User-Agent.
//
// So: drive the debug Chrome to a real page, and record every Voyager request
// the page itself issues. Those URLs — with their live queryIds and
// decorationIds — are the ground truth for `src/engine/contracts/`.
//
// This is ordinary browsing. The page load is one the user could perform by
// clicking, and no request is issued that the web client would not have made.
//
// USAGE
//   bun run scripts/observe.ts <path> [js-to-run-after-load]
//
//   bun run scripts/observe.ts /in/<your-public-id>/
//   bun run scripts/observe.ts /feed/
//   bun run scripts/observe.ts '/search/results/people/?keywords=rust' \
//     'document.querySelector("button[aria-label=\"Next\"]")?.click()'
//
// The optional second argument matters more than it looks. Several LinkedIn
// pages render their first result set server-side, so a plain navigation
// issues NO Voyager XHR for the thing you actually care about — search is the
// clearest case. Driving an in-page action (paginate, expand comments) is what
// makes the client fetch, and only then can you see the operation.
//
// Output: captures/observed-<slug>.json — unique Voyager URLs, plus a
// queryId → operation index.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const OUT = join(process.cwd(), 'captures');
const SETTLE_MS = 18_000;

interface Seen {
  url: string;
  method: string;
  queryId?: string;
  decorationId?: string;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? '/feed/';
  mkdirSync(OUT, { recursive: true });

  const list = (await (await fetch(`${CDP}/json/list`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }[];
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined);
  if (page?.webSocketDebuggerUrl === undefined) throw new Error('no debuggable page');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res) => {
    ws.onopen = () => res();
  });

  const seen = new Map<string, Seen>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      method?: string;
      params?: { request?: { url: string; method: string } };
    };
    if (msg.method !== 'Network.requestWillBeSent') return;
    const req = msg.params?.request;
    if (req === undefined || !req.url.includes('/voyager/api/')) return;

    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}${url.searchParams.get('queryId') ?? ''}`;
    if (seen.has(key)) return;

    const entry: Seen = { url: req.url, method: req.method };
    const queryId = url.searchParams.get('queryId');
    const decorationId = url.searchParams.get('decorationId');
    if (queryId !== null) entry.queryId = queryId;
    if (decorationId !== null) entry.decorationId = decorationId;
    seen.set(key, entry);
  };

  let id = 10;
  const send = (method: string, params: unknown): void => {
    ws.send(JSON.stringify({ id: id++, method, params }));
  };

  send('Network.enable', {});
  send('Page.enable', {});
  await new Promise((r) => setTimeout(r, 500));
  console.log(`navigating to https://www.linkedin.com${path} …`);
  send('Page.navigate', { url: `https://www.linkedin.com${path}` });

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const action = process.argv[3];
  if (action !== undefined) {
    console.log(`running in-page action, then settling again …`);
    send('Runtime.evaluate', { expression: action, awaitPromise: false });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }

  ws.close();

  const results = [...seen.values()].sort((a, b) => a.url.localeCompare(b.url));
  const slug = path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
  writeFileSync(join(OUT, `observed-${slug}.json`), JSON.stringify(results, null, 2));

  console.log(`\n${results.length} distinct Voyager calls observed:\n`);
  for (const r of results) {
    const p = new URL(r.url).pathname.replace('/voyager/api/', '');
    console.log(`  ${r.method} ${p}`);
    if (r.queryId !== undefined) console.log(`      queryId: ${r.queryId}`);
    if (r.decorationId !== undefined) console.log(`      decorationId: ${r.decorationId}`);
  }
  console.log(`\nwritten to captures/observed-${slug}.json`);
}

main().catch((e: Error) => {
  console.error(`observe failed: ${e.message}`);
  process.exit(1);
});
