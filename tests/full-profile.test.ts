import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fullProfileUrl,
  parseFullProfile,
  parsePositionsPage,
  positionsPageUrl,
} from '../src/engine/full-profile.ts';

// Captured 2026-10-16: a public figure's profile, chosen because it fills
// nearly every section (32 position groups, 6 schools, 47 skills, honors,
// publications, volunteering), and the rest of its experience from the
// position-groups resource. Every person in them is "Person N"; every free
// text (headline, About, descriptions, activities) is replaced.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const FULL = fixture('profile-full.json');
const PAGE = fixture('profile-positions-page.json');

describe('requests', () => {
  test('the profile by public id or profile id, with every section', () => {
    expect(fullProfileUrl('person-1')).toBe(
      'https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity' +
        '&memberIdentity=person-1' +
        '&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93',
    );
    expect(fullProfileUrl('nóra-x')).toContain('memberIdentity=n%C3%B3ra-x');
  });

  test('the rest of the experience, from where the profile stopped', () => {
    const u = new URL(positionsPageUrl('urn:li:fsd_profile:ACoAATESTPERSON1', 10));
    expect(u.pathname).toBe('/voyager/api/identity/dash/profilePositionGroups');
    expect(u.searchParams.get('q')).toBe('viewee');
    expect(u.searchParams.get('profileUrn')).toBe('urn:li:fsd_profile:ACoAATESTPERSON1');
    expect(u.searchParams.get('start')).toBe('10');
    expect(u.searchParams.get('count')).toBe('50');
  });
});

describe('the profile', () => {
  const read = () => {
    const r = parseFullProfile(FULL);
    if (!r.ok) throw new Error(r.message);
    return r.profile;
  };

  test('who: name, ids, headline, about, place, industry, and the top card as before', () => {
    expect(read()).toMatchObject({
      id: 'ACoAATESTPERSON1',
      urn: 'urn:li:fsd_profile:ACoAATESTPERSON1',
      publicId: 'person-1',
      name: 'Person 1',
      url: 'https://www.linkedin.com/in/person-1/',
      headline: 'Headline text',
      about: expect.stringMatching(/^Text \d+$/),
      location: 'United States',
      industry: 'Venture Capital & Private Equity',
      title: expect.any(String),
      company: expect.any(String),
      school: expect.any(String),
    });
  });

  // 10 position groups holding 10 positions; the parser emits 10, in the
  // profile's own order, each with its company. An 11th Position node is an
  // honor's link to an older role, not part of the first 10 groups.
  test('experience: every position, in order, with dates and descriptions', () => {
    const p = read();
    expect(p.experience).toHaveLength(10);
    expect(p.experience?.[0]).toMatchObject({
      company: 'Manas AI',
      start: '2025-01',
      current: true,
    });
    const chair = p.experience?.find((x) => x.title === 'Chair');
    expect(chair).toEqual({
      title: 'Chair',
      company: 'Village Global',
      companyId: '18265228',
      employmentType: 'Part-time',
      location: 'Seattle, WA',
      start: '2017-08',
      current: true,
      description: expect.stringMatching(/^Text \d+$/),
    });
    expect(p.counts).toMatchObject({ experience: { shown: 10, total: 32 } });
  });

  test('education with degree, field and years', () => {
    const p = read();
    expect(p.education).toHaveLength(6);
    expect(p.education?.find((e) => e.school === 'Oxford University')).toMatchObject({
      degree: 'M.St.',
      field: 'Philosophy',
      start: '1990-09',
      end: '1993-06',
    });
  });

  test('skills, and how many there are in all', () => {
    const p = read();
    expect(p.skills).toHaveLength(20);
    expect(p.skills?.[0]).toBe('CEOs');
    expect(p.counts).toMatchObject({ skills: { shown: 20, total: 47 } });
  });

  test('honors, publications and volunteering', () => {
    const p = read();
    expect(p.honors).toHaveLength(9);
    expect(p.honors?.find((h) => h.title === 'Distinguished Citizen Award')).toMatchObject({
      issuer: 'Commonwealth Club',
      issued: '2014-04',
    });
    expect(p.publications).toHaveLength(6);
    expect(p.publications?.find((x) => x.name === 'Impromptu')).toMatchObject({
      publisher: 'Amazon',
      published: '2023-03-14',
      url: 'https://www.amazon.com/Impromptu-Amplifying-Our-Humanity-Through/dp/B0BYLBPW8B/',
    });
    expect(p.volunteering).toHaveLength(14);
    expect(p.volunteering?.find((v) => v.organization === 'Kiva.org')).toMatchObject({
      role: 'Board of Directors',
      start: '2006-06',
      end: '2025-03',
    });
  });

  test('empty sections are left out, not sent as empty lists', () => {
    const p = read();
    expect(p.certifications).toBeUndefined();
    expect(p.languages).toBeUndefined();
  });

  test('a profile listed but not sent is drift; none listed is not found', () => {
    const drift = parseFullProfile({ ...FULL, included: [] });
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.code).toBe('SCHEMA_DRIFT');
    const none = parseFullProfile({ data: { ...FULL.data, '*elements': [] }, included: [] });
    if (none.ok) throw new Error('expected not found');
    expect(none.code).toBe('NOT_FOUND');
  });
});

describe('the rest of the experience', () => {
  // 22 more position groups holding 23 positions.
  test('each later position, read the same way', () => {
    const r = parsePositionsPage(PAGE);
    if (!r.ok) throw new Error(r.message);
    expect(r.experience).toHaveLength(23);
    expect(r.groups).toBe(22);
    expect(r.total).toBe(32);
    expect(r.experience.find((x) => x.company === 'OpenAI')).toMatchObject({
      title: 'Board Member',
    });
  });
});
