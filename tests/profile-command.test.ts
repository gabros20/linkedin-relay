import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberIdOf, type ProfileFetch, runProfile } from '../src/commands/profile.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const FULL = fixture('profile-full.json');
const PAGE = fixture('profile-positions-page.json');
const POSTS = readFileSync(join(import.meta.dir, 'fixtures', 'search-posts.rsc'), 'utf-8');
const SKILLS_1 = readFileSync(
  join(import.meta.dir, 'fixtures', 'profile-skills-page-1.rsc'),
  'utf-8',
);
const SKILLS_LAST = readFileSync(
  join(import.meta.dir, 'fixtures', 'profile-skills-page-last.rsc'),
  'utf-8',
);
const SKILLS_SCREEN =
  '"payload":{"vanityName":"person-1","profileId":"ACoAATESTPERSON1","start":0,"count":10,' +
  '"filter":"ProfileSkillCategory_ALL"}';
type Answer = Awaited<ReturnType<ProfileFetch>>;
const RECS = readFileSync(
  join(import.meta.dir, 'fixtures', 'profile-recommendations.rsc'),
  'utf-8',
);
const recsPage = (body: unknown): Answer => {
  const type = (
    body as { paginationRequest: { requestedArguments: { payload: { type: string } } } }
  ).paginationRequest.requestedArguments.payload.type;
  // 8 received on one page; none given.
  return {
    ok: true,
    raw: type === 'Received' ? RECS : '0:["$","div",null,{"isPartialPage":true}]',
  };
};
const CONTACT = readFileSync(
  join(import.meta.dir, 'fixtures', 'profile-contact-connection.rsc'),
  'utf-8',
);

const skillsPage = (body: unknown): Answer => {
  const start = (
    body as { paginationRequest: { requestedArguments: { payload: { start: number } } } }
  ).paginationRequest.requestedArguments.payload.start;
  // Four full pages of 10, then the last 7: 47, as the profile counts.
  return { ok: true, raw: start >= 40 ? SKILLS_LAST : SKILLS_1 };
};

/** What LinkedIn answers, by what is asked; the name is what `fails` turns off. */
const ROUTES: {
  name: string;
  is: (url: string, spendClass: string) => boolean;
  answer: (body: unknown) => Answer;
}[] = [
  {
    name: 'skills',
    is: (u) => u.includes('ProfileSkillDetails'),
    answer: () => ({ ok: true, raw: SKILLS_SCREEN }),
  },
  {
    name: 'skill-pages',
    is: (u) => u.includes('pagers.profile.details.skills'),
    answer: skillsPage,
  },
  { name: 'recommendations', is: (u) => u.includes('details.recommendations'), answer: recsPage },
  { name: 'posts', is: (_u, c) => c === 'search', answer: () => ({ ok: true, raw: POSTS }) },
  {
    name: 'contact',
    is: (u) => u.includes('ContactDetailsOverlay'),
    answer: () => ({ ok: true, raw: CONTACT }),
  },
  {
    name: 'page',
    is: (u) => u.includes('profilePositionGroups'),
    answer: () => ({ ok: true, json: PAGE }),
  },
];

function linkedin(fails: string[] = []) {
  const asked: { url: string; spendClass: string; body?: unknown }[] = [];
  const fetch: ProfileFetch = async (url, spendClass, body) => {
    asked.push({ url, spendClass, ...(body !== undefined ? { body } : {}) });
    const route = ROUTES.find((r) => r.is(url, spendClass));
    if (route === undefined) return { ok: true, json: FULL };
    if (fails.includes(route.name))
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'spent' };
    return route.answer(body);
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

  test('--contact: the contact info overlay for that member, one more profile read', async () => {
    const { fetch, asked } = linkedin();
    const p = data(await runProfile('person-1', {}, fetch, { contact: true }));
    const call = asked.find((a) => a.url.includes('ContactDetailsOverlay'));
    expect(call?.spendClass).toBe('profile');
    expect(call?.body).toMatchObject({
      clientArguments: {
        payload: { vanityName: 'person-1', givenName: 'Person', familyName: '1' },
      },
    });
    expect(p.contact).toEqual({ email: 'person-1@example.com', connectedSince: 'Jan 2, 2024' });
  });

  test('no --contact, no contact call', async () => {
    const { fetch, asked } = linkedin();
    await runProfile('person-1', {}, fetch);
    expect(asked.some((a) => a.url.includes('ContactDetailsOverlay'))).toBe(false);
  });

  test('the contact info failing keeps the profile, and says so', async () => {
    const p = data(
      await runProfile('person-1', {}, linkedin(['contact']).fetch, { contact: true }),
    );
    expect(p.name).toBe('Person 1');
    expect(p.contact).toBeUndefined();
    expect(p.contactError).toBe('BUDGET_EXHAUSTED: spent');
  });

  test('--posts N: their newest posts, from them only, on the search budget', async () => {
    const { fetch, asked } = linkedin();
    const p = data(await runProfile('person-1', {}, fetch, { posts: 3 }));
    const call = asked.find((a) => a.spendClass === 'search');
    const body = JSON.stringify(call?.body);
    // The profile id the profile answered with, and newest first.
    expect(body).toContain(String(p.id));
    expect(body).toContain('date_posted');
    expect((p.posts as unknown[]).length).toBe(3);
  });

  test('the posts failing keeps the profile, and says so', async () => {
    const p = data(await runProfile('person-1', {}, linkedin(['posts']).fetch, { posts: 3 }));
    expect(p.name).toBe('Person 1');
    expect(p.postsError).toContain('BUDGET_EXHAUSTED');
  });

  test("--skills: every skill, past the profile's 20, on the page budget", async () => {
    const { fetch, asked } = linkedin();
    const p = data(await runProfile('person-1', {}, fetch, { skills: true }));
    const pages = asked.filter((a) => a.url.includes('pagers.profile.details.skills'));
    expect(pages).toHaveLength(5);
    expect(pages.every((a) => a.spendClass === 'page')).toBe(true);
    expect(p.skills).toHaveLength(47);
    expect((p.skills as string[]).at(-1)).toBe('Technology Strategy');
    // Whole now: nothing says there are more.
    expect(p.counts).toBeUndefined();
  });

  test('the skills failing keeps the top 20, and says so', async () => {
    const p = data(await runProfile('person-1', {}, linkedin(['skills']).fetch, { skills: true }));
    expect(p.skills).toHaveLength(20);
    expect(p.skillsError).toContain('BUDGET_EXHAUSTED');
  });

  test('--recommendations: received and given, on the page budget', async () => {
    const { fetch, asked } = linkedin();
    const p = data(await runProfile('person-1', {}, fetch, { recommendations: true }));
    const calls = asked.filter((a) => a.url.includes('details.recommendations'));
    expect(calls.map((a) => a.spendClass)).toEqual(['page', 'page']);
    expect(JSON.stringify(calls[0]?.body)).toContain(String(p.id));
    const recs = p.recommendations as { received: { name: string }[]; given: unknown[] };
    expect(recs.received).toHaveLength(8);
    expect(recs.received[0]?.name).toBe('Person 1');
    expect(recs.given).toEqual([]);
  });

  test('the recommendations failing keeps the profile, and says so', async () => {
    const p = data(
      await runProfile('person-1', {}, linkedin(['recommendations']).fetch, {
        recommendations: true,
      }),
    );
    expect(p.recommendations).toBeUndefined();
    expect(p.recommendationsError).toContain('BUDGET_EXHAUSTED');
  });

  test('nothing to read is refused before any call', async () => {
    const { fetch, asked } = linkedin();
    expect((await runProfile('', {}, fetch)).ok).toBe(false);
    expect(asked).toHaveLength(0);
  });
});
