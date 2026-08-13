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

  // Attach at the BROWSER level, not to one page.
  //
  // The first version of this script picked a single page target at startup.
  // That silently misses everything the moment the user navigates to a new
  // tab, and it missed a real comment during the first capture attempt — the
  // comment landed on LinkedIn and the observer recorded nothing, which is the
  // most dangerous kind of failure for a tool whose job is observing. Browser
  // level + auto-attach covers every tab, iframe and worker, including ones
  // opened after we start watching.
  const version = (await (await fetch(`${CDP}/json/version`)).json()) as {
    webSocketDebuggerUrl?: string;
  };
  if (version.webSocketDebuggerUrl === undefined) {
    throw new Error('no browser-level CDP endpoint — is Chrome running with --remote-debugging-port=9222?');
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((res) => {
    ws.onopen = () => res();
  });

  let id = 100;
  const send = (method: string, params: unknown, sessionId?: string): void => {
    const msg: Record<string, unknown> = { id: id++, method, params };
    if (sessionId !== undefined) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  };

  const captured: Captured[] = [];
  const sessions = new Set<string>();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      method?: string;
      sessionId?: string;
      params?: {
        sessionId?: string;
        targetInfo?: { type: string; url: string };
        request?: {
          url: string;
          method: string;
          headers: Record<string, string>;
          postData?: string;
        };
      };
    };

    // Every new target gets Network enabled on its own session.
    if (msg.method === 'Target.attachedToTarget') {
      const sessionId = msg.params?.sessionId;
      if (sessionId !== undefined && !sessions.has(sessionId)) {
        sessions.add(sessionId);
        send('Network.enable', {}, sessionId);
        // RECURSE. Attaching at the browser level yields the page targets, but
        // not the workers underneath them — and a browser-level-only attach saw
        // 1 session where this sees 8. A comment that demonstrably landed was
        // missed twice before this line existed.
        send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          sessionId,
        );
      }
      return;
    }

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

  send('Target.setDiscoverTargets', { discover: true });
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await new Promise((r) => setTimeout(r, 800));

  console.log(`watching ALL tabs and workers for Voyager writes for ${seconds}s.`);
  console.log(`${sessions.size} target(s) attached.`);
  console.log('go to the browser and perform the action(s).\n');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  ws.close();

  if (captured.length === 0) {
    console.log('\nno mutating Voyager request seen.');
    console.log('if you did act, the client may route writes through a host or worker this');
    console.log('still does not see — worth recording in ENGINE-RESEARCH.md rather than retrying blind.');
    return;
  }

  // A fixed name would be overwritten by the next run; these are hard to re-take.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(OUT, `write-${stamp}.json`);
  writeFileSync(file, JSON.stringify(captured, null, 2));
  console.log(`\n${captured.length} mutating call(s) captured -> ${file}`);
}

main().catch((e: Error) => {
  console.error(`observe-write failed: ${e.message}`);
  process.exit(1);
});
