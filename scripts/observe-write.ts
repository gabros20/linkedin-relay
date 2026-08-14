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

/**
 * Known telemetry, excluded so the signal is readable. `to11y` is the
 * numeronym for observability; both it and `tapie` use randomised paths and
 * binary bodies. Excluding by name is safe here in a way an accept-list is
 * not: a new write endpoint shows up, a new telemetry endpoint is just noise.
 */
const TELEMETRY =
  /to11y|tapie|sensorCollect|realtimeFrontendClientConnectivityTracking|protechts\.net|\/li\/track/;

/**
 * Response bodies are capped. The comment harvest was 2.8 MB of RSC stream and
 * the interesting part was in the first few KB; an uncapped capture is mostly
 * page markup we will never read, and it makes the file too big to open.
 */
const MAX_BODY = 256 * 1024;

interface Captured {
  method: string;
  url: string;
  /** Credential values replaced with a length marker; names are kept. */
  headers: Record<string, string>;
  postData?: unknown;
  postDataRaw?: string;
  // ─── The response half ──────────────────────────────────────────────────────
  //
  // The first version of this script recorded requests ONLY. That is enough to
  // learn the shape we must SEND, and it was enough for share/comment/react —
  // so the gap went unnoticed until media upload, where the whole protocol is
  // in the reply: registering an upload returns the URL to PUT to and the urn
  // to reference afterwards. Neither is derivable from the request.
  //
  // Same failure family as the voyager-only URL filter this file already
  // carries a warning about: an instrument blind to half the exchange reports
  // confidently on the half it can see.
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  responseBodyRaw?: string;
  responseTruncated?: boolean;
  /** Set when the body could not be read at all, with Chrome's reason. */
  responseError?: string;
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
    throw new Error(
      'no browser-level CDP endpoint — is Chrome running with --remote-debugging-port=9222?',
    );
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

  // requestId is only unique per session, so both halves of the key matter.
  const tracked = new Map<string, Captured>();
  const trackedSession = new Map<string, string>();
  /** Outstanding Network.getResponseBody calls, by the id we sent them under. */
  const awaitingBody = new Map<number, string>();
  const key = (sessionId: string | undefined, requestId: string): string =>
    `${sessionId ?? '-'}:${requestId}`;

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      method?: string;
      sessionId?: string;
      error?: { message?: string };
      result?: { body?: string; base64Encoded?: boolean };
      params?: {
        sessionId?: string;
        requestId?: string;
        targetInfo?: { type: string; url: string };
        response?: { status: number; headers: Record<string, string> };
        request?: {
          url: string;
          method: string;
          headers: Record<string, string>;
          postData?: string;
        };
      };
    };

    // ── A Network.getResponseBody reply coming back ──────────────────────────
    if (msg.id !== undefined && awaitingBody.has(msg.id)) {
      const k = awaitingBody.get(msg.id) as string;
      awaitingBody.delete(msg.id);
      const entry = tracked.get(k);
      if (entry === undefined) return;

      if (msg.error !== undefined || msg.result?.body === undefined) {
        // Chrome evicts bodies it no longer holds. Recording WHY beats a silent
        // absence that reads identically to "the server sent nothing".
        entry.responseError = msg.error?.message ?? 'no body returned by Chrome';
        return;
      }
      const body = msg.result.base64Encoded === true ? '<binary>' : msg.result.body;
      entry.responseTruncated = body.length > MAX_BODY;
      entry.responseBodyRaw = body.slice(0, MAX_BODY);
      try {
        entry.responseBody = JSON.parse(body) as unknown;
      } catch {
        // Not JSON — an RSC stream or a redirect page. Raw is the record.
      }
      const path = new URL(entry.url).pathname.replace('/voyager/api/', '');
      console.log(`  <- ${entry.status} ${path}: ${(entry.responseBodyRaw ?? '').slice(0, 900)}`);
      return;
    }

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

    // ── The response half, for requests we decided to track ──────────────────
    if (msg.method === 'Network.responseReceived') {
      const entry = tracked.get(key(msg.sessionId, msg.params?.requestId ?? ''));
      if (entry === undefined || msg.params?.response === undefined) return;
      entry.status = msg.params.response.status;
      entry.responseHeaders = redact(msg.params.response.headers);
      return;
    }

    // The body is only readable once the transfer completes.
    if (msg.method === 'Network.loadingFinished') {
      const requestId = msg.params?.requestId ?? '';
      const k = key(msg.sessionId, requestId);
      if (!tracked.has(k)) return;
      const callId = id++;
      awaitingBody.set(callId, k);
      const call: Record<string, unknown> = {
        id: callId,
        method: 'Network.getResponseBody',
        params: { requestId },
      };
      const sessionId = trackedSession.get(k);
      if (sessionId !== undefined) call.sessionId = sessionId;
      ws.send(JSON.stringify(call));
      return;
    }

    if (msg.method !== 'Network.requestWillBeSent') return;
    const req = msg.params?.request;
    if (req === undefined) return;
    if (!MUTATING.has(req.method)) return;
    // NOT voyager-only. Reactions go to /flagship-web/rsc-action/ (SDUI over
    // React Server Components), an entirely different surface — a voyager-only
    // filter was structurally blind to them and reported "no writes seen"
    // while reactions were demonstrably landing. Filter out the known
    // telemetry instead, and record everything else.
    if (TELEMETRY.test(req.url)) return;

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
    const k = key(msg.sessionId, msg.params?.requestId ?? '');
    tracked.set(k, entry);
    if (msg.sessionId !== undefined) trackedSession.set(k, msg.sessionId);

    const path = new URL(req.url).pathname.replace('/voyager/api/', '');
    console.log(`\n  ${req.method} ${path}`);
    if (entry.postData !== undefined) {
      console.log(`  body: ${JSON.stringify(entry.postData).slice(0, 1500)}`);
    }
  };

  send('Target.setDiscoverTargets', { discover: true });
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await new Promise((r) => setTimeout(r, 800));

  console.log(`watching ALL tabs and workers for write traffic for ${seconds}s.`);
  console.log(`${sessions.size} target(s) attached.`);
  console.log('go to the browser and perform the action(s).\n');
  await new Promise((r) => setTimeout(r, seconds * 1000));

  // Bodies requested in the last moments are still in flight. Closing here
  // would drop exactly the response to the last action performed — which, in a
  // session driven by hand, is usually the one that mattered most.
  for (let i = 0; i < 20 && awaitingBody.size > 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (awaitingBody.size > 0) {
    console.log(
      `\n${awaitingBody.size} response body/bodies never arrived; recorded without them.`,
    );
  }
  ws.close();

  if (captured.length === 0) {
    console.log('\nno mutating Voyager request seen.');
    console.log('if you did act, the client may route writes through a host or worker this');
    console.log(
      'still does not see — worth recording in ENGINE-RESEARCH.md rather than retrying blind.',
    );
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
