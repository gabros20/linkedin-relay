import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberIdOf, type ProfileFetch, runProfile } from '../src/commands/profile.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const FULL = fixture('profile-full.json');
const PAGE = fixture('profile-positions-page.json');

function linkedin(fails: string[] = []) {
  const asked: { url: string; spendClass: string }[] = [];
  const fetch: ProfileFetch = async (url, spendClass) => {
    asked.push({ url, spendClass });
    if (url.includes('profilePositionGroups')) {
      if (fails.includes('page')) return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'spent' };
      return { ok: true, json: PAGE };
    }
    return { ok: true, json: FULL };
  };
  return { fetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runProfile>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as Record<string, unknown> & {
    experience: unknown[];
    counts?: Record<string, unknown>;
  };
};

describe('which profile', () => {
  test('a public id, a profile URL (decoded), a urn or a profile id', () => {
    expect(memberIdOf('person-1')).toBe('person-1');
    expect(memberIdOf('https://www.linkedin.com/in/n%C3%B3ra-x/')).toBe('nóra-x');
    expect(memberIdOf('urn:li:fsd_profile:ACoAATESTPERSON1')).toBe('ACoAATESTPERSON1');
    expect(memberIdOf('ACoAATESTPERSON1')).toBe('ACoAATESTPERSON1');
  });
});

describe('lnrelay profile', () => {
  test('the profile in full, its whole experience read on, on the profile budget', async () => {
    const { fetch, asked } = linkedin();
    const p = data(await runProfile('https://www.linkedin.com/in/person-1/', {}, fetch));
    expect(asked.map((a) => a.spendClass)).toEqual(['profile', 'profile']);
    expect(asked[1]?.url).toContain('start=10');
    expect(p.name).toBe('Person 1');
    // 10 roles in the profile, 23 more in the next page.
    expect(p.experience).toHaveLength(33);
    // Experience is whole now; only skills say there are more.
    expect(p.counts).toEqual({ skills: { shown: 20, total: 47 } });
  });

  test('the rest of the experience failing keeps what came, and says so', async () => {
    const p = data(await runProfile('person-1', {}, linkedin(['page']).fetch));
    expect(p.experience).toHaveLength(10);
    expect(p.counts).toMatchObject({ experience: { shown: 10, total: 32 } });
    expect(p.experienceError).toBe('BUDGET_EXHAUSTED: spent');
  });

  test('--compact: one line per role, school and entry, and no descriptions', async () => {
    const p = data(await runProfile('person-1', { compact: true }, linkedin().fetch));
    expect(p.experience[0]).toBe('Co-Founder, Executive Board Chair | Manas AI | 2025-01 – now');
    expect(p.experience.every((r) => typeof r === 'string')).toBe(true);
    expect(JSON.stringify(p)).not.toContain('"description"');
    expect((p.education as string[]).find((e) => e.startsWith('Oxford University'))).toBe(
      'Oxford University | M.St. | Philosophy | 1990-09 – 1993-06',
    );
  });

  test('--fields keeps only the named fields', async () => {
    const p = data(await runProfile('person-1', { fields: 'name,skills' }, linkedin().fetch));
    expect(Object.keys(p).sort()).toEqual(['name', 'skills']);
  });

  test('nothing to read is refused before any call', async () => {
    const { fetch, asked } = linkedin();
    expect((await runProfile('', {}, fetch)).ok).toBe(false);
    expect(asked).toHaveLength(0);
  });
});
