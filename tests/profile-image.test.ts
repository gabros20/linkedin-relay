import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath, saveJson } from '../src/cache/store.ts';
import type { ConfirmDeps } from '../src/commands/confirm.ts';
import { type ImageSurface, runEditImage } from '../src/commands/profile-image.ts';
import type { ImageKeys } from '../src/engine/sdui-profile-image.ts';

const T0 = 1_800_000_000_000;

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-image-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
  saveJson(cachePath('session.json'), {
    liAt: 'a'.repeat(40),
    jsessionId: '"ajax:1"',
    userAgent: 'Mozilla/5.0',
    capturedAt: '2026-08-01',
  });
});
afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const noTty: ConfirmDeps = { isTty: false, prompt: async () => '', write: () => {} };
const planning = { ...noTty, approval: { mode: 'agent' as const, planOnly: true } };
const confirming = (token: string) => ({ ...noTty, approval: { mode: 'agent' as const, token } });

/** A PNG header of the given size: all the command reads of the file. */
function png(name: string, width: number, height: number): string {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  const path = join(dir, name);
  writeFileSync(path, b);
  return path;
}

const KEYS: ImageKeys = {
  originalMedia: 'k-om',
  originalAssetUrns: 'k-ou',
  displayMedia: 'k-dm',
  displayAssetUrns: 'k-du',
  saving: 'k-s',
  originalPointer: 'p-orig',
  displayPointer: 'p-disp',
};

/** The register answer: our keys set to asset ids, and an upload url for each pointer. */
const REGISTERED =
  '0:' +
  JSON.stringify({
    response: {
      errors: [],
      completionAction: {
        actions: [
          {
            $type: 'proto.sdui.actions.core.SetState',
            value: {
              state: {
                key: { key: { value: { id: 'k-ou' } } },
                value: { stringListValue: { stringValues: ['NEWORIG'] } },
              },
            },
          },
          {
            $type: 'proto.sdui.actions.core.SetState',
            value: {
              state: {
                key: { key: { value: { id: 'k-du' } } },
                value: { stringListValue: { stringValues: ['NEWDISP'] } },
              },
            },
          },
          ...['p-disp', 'p-orig'].map((p) => ({
            fileReference: p,
            uploadInstruction: {
              instruction: {
                singleRequestUploadInstruction: {
                  uploadUrl: `https://www.linkedin.com/dms-uploads/${p}`,
                  uploadHeaders: [{ key: 'mediaTypeFamily', value: 'STILLIMAGE' }],
                },
              },
            },
          })),
        ],
      },
    },
  });

function linkedin(opts: { saves?: boolean; fail?: string } = {}) {
  let showing = { photo: 'OLDPHOTO', banner: 'OLDBANNER' } as Record<string, string>;
  const calls: string[] = [];
  const s: ImageSurface = {
    vanity: async () => ({ ok: true, vanity: 'person-1' }),
    pictures: async () => ({ ok: true, profileId: 'ACoAATESTPERSON1', ...showing }),
    register: async (_body) => {
      calls.push('register');
      if (opts.fail === 'register')
        return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'spent' };
      return { ok: true, raw: REGISTERED };
    },
    put: async (upload) => {
      calls.push(`put ${upload.url.split('/').pop()}`);
      return { ok: true };
    },
    save: async (kind) => {
      calls.push(`save ${kind.name}`);
      if (opts.saves !== false) showing = { ...showing, [kind.name]: 'NEWDISP' };
      return { ok: true };
    },
  };
  return { s, calls };
}

async function approve(name: string, path: string, s: ImageSurface) {
  const plan = await runEditImage(name, path, T0, planning, s, KEYS);
  if (!plan.ok) throw new Error(plan.error.message);
  const token = (plan.data as { token: string }).token;
  return { plan, done: await runEditImage(name, path, T0 + 60_000, confirming(token), s, KEYS) };
}

describe('lnrelay edit photo|banner <file>', () => {
  test('register, upload both copies, save, and read it back', async () => {
    const { s, calls } = linkedin();
    const { plan, done } = await approve('photo', png('me.png', 400, 400), s);
    expect(JSON.stringify(plan.data)).toContain('400 × 400');
    expect(calls).toEqual(['register', 'put p-orig', 'put p-disp', 'save photo']);
    expect(done).toMatchObject({
      ok: true,
      data: { image: 'photo', verified: true, asset: 'NEWDISP' },
    });
  });

  test('the plan sends nothing', async () => {
    const { s, calls } = linkedin();
    await runEditImage('banner', png('b.png', 1584, 396), T0, planning, s, KEYS);
    expect(calls).toEqual([]);
  });

  test('the wrong shape is refused before anything is sent', async () => {
    const { s, calls } = linkedin();
    const photo = await runEditImage('photo', png('wide.png', 800, 400), T0, planning, s, KEYS);
    expect(photo).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const banner = await runEditImage('banner', png('sq.png', 400, 400), T0, planning, s, KEYS);
    expect(banner).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toEqual([]);
  });

  test('not a PNG or JPEG is refused', async () => {
    const path = join(dir, 'x.gif');
    writeFileSync(path, 'GIF89a');
    const r = await runEditImage('photo', path, T0, planning, linkedin().s, KEYS);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  test('a save that does not read back is not a success', async () => {
    const { s } = linkedin({ saves: false });
    const { done } = await approve('banner', png('b.png', 1584, 396), s);
    expect(done).toMatchObject({ ok: false, error: { code: 'SCHEMA_DRIFT' } });
  });

  test('the register failing says nothing changed', async () => {
    const { s, calls } = linkedin({ fail: 'register' });
    const { done } = await approve('photo', png('me.png', 400, 400), s);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.message).toContain('nothing changed');
    expect(calls).toEqual(['register']);
  });
});
