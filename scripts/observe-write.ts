#!/usr/bin/env bun
// ─── Capture what the real client sends when it WRITES ────────────────────────
//
// `observe.ts` records which Voyager endpoints a page calls. That is enough to
// discover a read, because a read is a GET and the URL carries everything. A
// write is a POST: the interesting part is the BODY, and the body is exactly
// what we would otherwise have to guess from someone's 2019 Python client.
//
// So this records method, URL, headers and postData for every mutating Voyager
// request the page makes — and nothing else. Then we implement the write from
// the capture instead of from lore, which is the same standard every read in
// this tool was held to: observe to discover, probe to verify, trust only what
// returned 200 on this machine.
//
// You drive the browser by hand. Nothing here clicks anything: an automated
// write we did not understand is precisely what we are trying to avoid.
//
// USAGE
//   1. lnrelay login          (or launch Chrome with --remote-debugging-port=9222)
//   2. bun run scripts/observe-write.ts [seconds]
//   3. In that Chrome, perform ONE action — write a post, comment, or react.
//   4. The capture lands in captures/write-<timestamp>.json
//
// Credentials are REDACTED before anything touches disk. captures/ is
// gitignored, but a cookie written to a file is a cookie that can leak, and
// "it was in a gitignored directory" is not a story worth telling.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const OUT = join(process.cwd(), 'captures');

/** Anything whose value is a credential rather than a shape we need to learn. */
const SECRET_HEADERS = new Set(['cookie', 'csrf-token', 'set-cookie', 'authorization']);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface Captured {
  method: string;
  url: string;
  /** Credential values replaced with a length marker; names are kept. */
  headers: Record<string, string>;
  postData?: unknown;
  postDataRaw?: string;
}

function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase())
      ? `<redacted, ${value.length} chars>`
      : value;
  }
  return out;
}

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] ?? 120);
  mkdirSync(OUT, { recursive: true });

  const list = (await (await fetch(`${CDP}/json/list`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }[];
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined);
  if (page?.webSocketDebuggerUrl === undefined) {
    throw new Error('no debuggable page — run `lnrelay login` first, or start Chrome with --remote-debugging-port=9222');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res) => {
    ws.onopen = () => res();
  });

  const captured: Captured[] = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      method?: string;
      params?: {
        request?: {
          url: string;
          method: string;
          headers: Record<string, string>;
          postData?: string;
        };
      };
    };
    if (msg.method !== 'Network.requestWillBeSent') return;
    const req = msg.params?.request;
    if (req === undefined) return;
    if (!req.url.includes('/voyager/api/')) return;
    if (!MUTATING.has(req.method)) return;

    const entry: Captured = { method: req.method, url: req.url, headers: redact(req.headers) };
    if (req.postData !== undefined) {
      entry.postDataRaw = req.postData;
      try {
        entry.postData = JSON.parse(req.postData) as unknown;
      } catch {
        // Not JSON — the raw form is the record then.
      }
    }
    captured.push(entry);

    const path = new URL(req.url).pathname.replace('/voyager/api/', '');
    console.log(`\n  ${req.method} ${path}`);
    if (entry.postData !== undefined) {
      console.log(`  body: ${JSON.stringify(entry.postData).slice(0, 400)}`);
    }
  };

  ws.send(JSON.stringify({ id: 1, method: 'Network.enable', params: {} }));

  console.log(`watching for Voyager writes for ${seconds}s.`);
  console.log('go to the browser and perform ONE action — post, comment, or react.\n');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  ws.close();

  if (captured.length === 0) {
    console.log('\nno mutating Voyager request seen.');
    console.log('if you did act, the client may route writes through a different host or a');
    console.log('service worker — worth knowing, and worth recording in ENGINE-RESEARCH.md.');
    return;
  }

  // A fixed name would be overwritten by the next run; these are hard to re-take.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(OUT, `write-${stamp}.json`);
  writeFileSync(file, JSON.stringify(captured, null, 2));
  console.log(`\n${captured.length} mutating call(s) captured → ${file}`);
}

main().catch((e: Error) => {
  console.error(`observe-write failed: ${e.message}`);
  process.exit(1);
});
