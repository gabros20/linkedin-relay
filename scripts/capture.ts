#!/usr/bin/env bun
// ─── Phase 0: the viability gate ──────────────────────────────────────────────
//
// This decides whether linkedin-relay is buildable at all. It is deliberately
// NOT part of the shipped tool: it is a throwaway experiment you run once, by
// hand, on your own machine and your own residential IP.
//
// It answers exactly one question: does raw HTTP with your own session cookies
// still reach Voyager in 2026, or has LinkedIn closed that door?
//
//   1. You log into LinkedIn in a normal Chrome window.
//   2. This mints cookies from that real profile over CDP.
//   3. It issues THREE requests, spaced ~15s apart.
//   4. It dumps raw bodies to captures/ and prints the status codes.
//
// Read docs/PLAN.md "Phase 0" for how to interpret the outcome. In short:
// three 200s → build. A 999 or a challenge → abandon; do not reach for a
// stealth browser, because the thing that blocked you is precisely what a
// browser would be evading.
//
// USAGE
//   1. Quit Chrome completely.
//   2. Relaunch it with remote debugging:
//        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//          --remote-debugging-port=9222 --user-data-dir="$HOME/.lnrelay/chrome"
//   3. Log into linkedin.com in that window. Visit your feed at least once.
//   4. bun run scripts/capture.ts
//
// Nothing here is committed: captures/ is gitignored, and it contains both live
// session tokens and third-party personal data. Redact by hand into
// tests/fixtures/ before any of it goes near the repo.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const OUT = join(process.cwd(), 'captures');
const GAP_MS = 15_000;

interface Cookie {
  name: string;
  value: string;
  domain: string;
}

async function cdpCookies(): Promise<Cookie[]> {
  const targetsRes = await fetch(`${CDP}/json/list`);
  if (!targetsRes.ok) {
    throw new Error(
      `Chrome DevTools endpoint not reachable at ${CDP}. Relaunch Chrome with ` +
        '--remote-debugging-port=9222 (see the usage note at the top of this file).',
    );
  }
  const targets = (await targetsRes.json()) as { webSocketDebuggerUrl?: string; type: string }[];
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined);
  if (page?.webSocketDebuggerUrl === undefined) throw new Error('no debuggable Chrome page found');

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl as string);
    const timer = setTimeout(() => reject(new Error('CDP timed out')), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { cookies: Cookie[] } };
      if (msg.id === 1 && msg.result !== undefined) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result.cookies);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP websocket error'));
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const all = await cdpCookies();
  const linkedin = all.filter((c) => c.domain.includes('linkedin.com'));
  const liAt = linkedin.find((c) => c.name === 'li_at');
  const jsession = linkedin.find((c) => c.name === 'JSESSIONID');

  if (liAt === undefined || jsession === undefined) {
    throw new Error(
      'li_at or JSESSIONID missing. Log into linkedin.com in the debug Chrome window and ' +
        'visit /feed/ at least once — that navigation is specifically what sets JSESSIONID.',
    );
  }

  // The csrf-token header is JSESSIONID with its surrounding quotes stripped —
  // a derivation, not a separate secret. (Verified, R3 §1.)
  const csrf = jsession.value.replace(/"/g, '');
  console.log(
    `cookies ok — li_at len ${liAt.value.length}, JSESSIONID len ${jsession.value.length}\n` +
      `other linkedin cookies present: ${linkedin.map((c) => c.name).join(', ')}\n`,
  );

  // Use the CURRENT browser UA. A stale UA measurably raises the challenge rate
  // (R3 §5) — never hardcode the Chrome 83 string from the 2024 reference client.
  const ua = process.env.LNRELAY_UA ?? navigatorUa();

  const headers = {
    cookie: `li_at=${liAt.value}; JSESSIONID=${jsession.value}`,
    'csrf-token': csrf,
    'x-restli-protocol-version': '2.0.0',
    accept: 'application/vnd.linkedin.normalized+json+2.1',
    'x-li-lang': 'en_US',
    'user-agent': ua,
  };

  const probes = [
    { name: 'me', url: 'https://www.linkedin.com/voyager/api/me' },
    {
      name: 'profileView',
      url: `https://www.linkedin.com/voyager/api/identity/profiles/${process.env.LNRELAY_PUBLIC_ID ?? 'me'}/profileView`,
    },
    // Deliberately last: search is the most fingerprintable of the three.
    {
      name: 'feed',
      url: 'https://www.linkedin.com/voyager/api/feed/updatesV2?q=chronFeed&count=5&start=0',
    },
  ];

  const results: { name: string; status: number; bytes: number; verdict: string }[] = [];

  for (const [i, probe] of probes.entries()) {
    if (i > 0) {
      console.log(`waiting ${GAP_MS / 1000}s…`);
      await sleep(GAP_MS);
    }
    console.log(`→ ${probe.name}`);
    const res = await fetch(probe.url, { headers, redirect: 'manual' });
    const body = await res.text();
    writeFileSync(join(OUT, `${probe.name}.${res.status}.json`), body);

    let verdict = 'ok';
    if (res.status === 999) verdict = 'BLOCKED — HTTP 999. Kill criterion #1.';
    else if (res.status === 302 || res.status === 401 || res.status === 403) {
      verdict = 'AUTH — redirect/denied. Usually expired cookies, not detection.';
    } else if (/challenge|checkpoint|captcha/i.test(body.slice(0, 2000))) {
      verdict = 'CHALLENGE — detection fired. Kill criterion #1.';
    } else if (res.status !== 200) verdict = `unexpected ${res.status}`;

    results.push({ name: probe.name, status: res.status, bytes: body.length, verdict });
    console.log(`   ${res.status} · ${body.length} bytes · ${verdict}`);
  }

  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));

  const allOk = results.every((r) => r.status === 200 && r.verdict === 'ok');
  console.log(
    `\n${'─'.repeat(60)}\n${
      allOk
        ? 'GATE PASSED. Raw HTTP still reaches Voyager. Proceed to Phase 2.\n' +
          'Next: re-scrape queryIds daily for 14 days to measure rotation cadence.'
        : 'GATE FAILED. Read docs/DESIGN.md §9 before doing anything else.\n' +
          'Do NOT reach for a stealth browser — see kill criteria.'
    }\n\nRaw bodies in ./captures (gitignored — redact by hand before using as fixtures).`,
  );
}

function navigatorUa(): string {
  // A current desktop Chrome UA. Update this alongside your real browser; the
  // capture prints it so you can see what was actually sent.
  return (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  );
}

main().catch((e: Error) => {
  console.error(`\ncapture failed: ${e.message}`);
  process.exit(1);
});
