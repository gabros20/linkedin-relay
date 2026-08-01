// Session persistence and the CDP bootstrap.
//
// Credentials live in a 0600 file under the cache dir. The design calls for OS
// credential storage; that is a Phase 6 hardening step and is recorded as such
// rather than silently skipped — for now the file is owner-only and the path is
// gitignored.

import { cachePath, loadJson, saveJson } from '../cache/store.ts';
import type { Session } from './auth.ts';

const SESSION_FILE = 'session.json';

export type SessionLoad =
  | { state: 'ok'; session: Session }
  | { state: 'missing' }
  | { state: 'corrupt'; quarantinedTo: string };

export function loadSession(): SessionLoad {
  const result = loadJson<Session>(cachePath(SESSION_FILE));
  if (result.state === 'ok') return { state: 'ok', session: result.value };
  if (result.state === 'missing') return { state: 'missing' };
  return { state: 'corrupt', quarantinedTo: result.quarantinedTo };
}

export function saveSession(session: Session): void {
  saveJson(cachePath(SESSION_FILE), session);
}

// ─── CDP bootstrap ────────────────────────────────────────────────────────────

const CDP = 'http://127.0.0.1:9222';

export const LAUNCH_HINT =
  'Start Chrome with remote debugging first, DETACHED so it survives:\n' +
  '  nohup /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n' +
  '    --remote-debugging-port=9222 --user-data-dir="$HOME/.lnrelay/chrome" \\\n' +
  '    https://www.linkedin.com/feed/ >/dev/null 2>&1 & disown\n' +
  'Then log into LinkedIn in that window and visit /feed/ once.';

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * Mint a session from a logged-in Chrome over the DevTools protocol.
 *
 * Visiting `/feed/` matters: that navigation is specifically what sets
 * JSESSIONID. A jar with JSESSIONID but no li_at means the browser has been to
 * linkedin.com but nobody has logged in.
 */
export async function mintSessionFromBrowser(): Promise<
  { ok: true; session: Session } | { ok: false; message: string; hint?: string }
> {
  let targets: { type: string; webSocketDebuggerUrl?: string }[];
  let userAgent: string;
  try {
    targets = (await (await fetch(`${CDP}/json/list`)).json()) as typeof targets;
    const version = (await (await fetch(`${CDP}/json/version`)).json()) as {
      'User-Agent'?: string;
    };
    userAgent = (version['User-Agent'] ?? '').replace('HeadlessChrome', 'Chrome');
  } catch {
    return { ok: false, message: `no Chrome DevTools endpoint at ${CDP}`, hint: LAUNCH_HINT };
  }

  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined);
  if (page?.webSocketDebuggerUrl === undefined) {
    return { ok: false, message: 'no debuggable Chrome page found', hint: LAUNCH_HINT };
  }
  if (userAgent === '') {
    return { ok: false, message: 'Chrome did not report a User-Agent' };
  }

  let cookies: CdpCookie[];
  try {
    cookies = await getAllCookies(page.webSocketDebuggerUrl);
  } catch (e) {
    return { ok: false, message: `CDP failed: ${(e as Error).message}`, hint: LAUNCH_HINT };
  }

  const linkedin = cookies.filter((c) => c.domain.includes('linkedin.com'));
  const liAt = linkedin.find((c) => c.name === 'li_at');
  const jsession = linkedin.find((c) => c.name === 'JSESSIONID');

  if (liAt === undefined) {
    return {
      ok: false,
      message: 'no li_at cookie — you are not logged in',
      hint: 'Log into linkedin.com in the debug Chrome window, then re-run. Note that JSESSIONID alone is set pre-login and does not mean a session exists.',
    };
  }
  if (jsession === undefined) {
    return {
      ok: false,
      message: 'no JSESSIONID cookie',
      hint: 'Visit https://www.linkedin.com/feed/ in the debug window — that navigation is what sets it.',
    };
  }

  return {
    ok: true,
    session: {
      liAt: liAt.value,
      jsessionId: jsession.value,
      userAgent,
      capturedAt: new Date().toISOString().slice(0, 10),
    },
  };
}

function getAllCookies(wsUrl: string): Promise<CdpCookie[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out talking to Chrome'));
    }, 10_000);

    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { cookies: CdpCookie[] } };
      if (msg.id === 1 && msg.result !== undefined) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result.cookies);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('websocket error'));
    };
  });
}
