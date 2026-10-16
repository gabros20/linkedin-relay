import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { companyRefOf, companyUrl, parseCompany } from '../src/engine/company.ts';

// Captured 2026-10-14: Microsoft's page, once by its universal name (a
// collection of one) and once by its id (the company itself), image fields
// removed. Public company data; no member appears in either.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const BY_NAME = fixture('company-by-name.json');
const BY_ID = fixture('company-by-id.json');

describe('which company', () => {
  test('a name, a page URL, a showcase URL, an id or a urn', () => {
    expect(companyRefOf('microsoft')).toEqual({ name: 'microsoft' });
    expect(companyRefOf('https://www.linkedin.com/company/microsoft/about/')).toEqual({
      name: 'microsoft',
    });
    expect(companyRefOf('linkedin.com/showcase/microsoftresearch')).toEqual({
      name: 'microsoftresearch',
    });
    expect(companyRefOf('1035')).toEqual({ id: '1035' });
    expect(companyRefOf('https://www.linkedin.com/company/1035/')).toEqual({ id: '1035' });
    expect(companyRefOf('urn:li:fsd_company:1035')).toEqual({ id: '1035' });
    expect(companyRefOf('urn:li:organization:1035')).toEqual({ id: '1035' });
    expect(companyRefOf('not a company')).toBeUndefined();
    expect(companyRefOf('https://www.linkedin.com/in/someone/')).toBeUndefined();
  });

  test('by id the company itself; by name the universal-name finder', () => {
    expect(companyUrl({ id: '1035' })).toBe(
      'https://www.linkedin.com/voyager/api/organization/companies/1035' +
        '?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12',
    );
    expect(companyUrl({ name: 'microsoft' })).toBe(
      'https://www.linkedin.com/voyager/api/organization/companies' +
        '?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12' +
        '&q=universalName&universalName=microsoft',
    );
  });
});

describe('the page', () => {
  test('the About tab: what it does, site, industry, size, followers, where, specialties', () => {
    const r = parseCompany(BY_NAME);
    if (!r.ok) throw new Error(r.message);
    const c = r.company;
    expect(c).toMatchObject({
      id: '1035',
      name: 'Microsoft',
      universalName: 'microsoft',
      url: 'https://www.linkedin.com/company/microsoft/',
      website: 'https://news.microsoft.com/',
      industry: 'Software Development',
      type: 'Public Company',
      size: '10,001+',
      employeesOnLinkedIn: 231136,
      followers: 29296702,
      headquarters: '1 Microsoft Way, Redmond, Washington 98052, US',
    });
    expect(c.about?.startsWith('Every company has a mission.')).toBe(true);
    expect(c.specialties).toHaveLength(23);
    expect(c.specialties?.[0]).toBe('Business Software');
    expect(c.locations?.[0]).toBe('1 Microsoft Way, Redmond, Washington 98052, US');
    expect(c.jobsUrl).toContain('/jobs/search?');
  });

  // 7 affiliated pages; the parser emits 7, each named.
  test('affiliated pages and showcase pages, by id and name', () => {
    const r = parseCompany(BY_NAME);
    if (!r.ok) throw new Error(r.message);
    expect(r.company.affiliated).toHaveLength(7);
    expect(r.company.affiliated?.every((a) => a.name !== '' && /^\d+$/.test(a.id))).toBe(true);
    expect(r.company.showcasePages?.find((p) => p.id === '79153021')).toEqual({
      id: '79153021',
      name: 'Microsoft Research',
      url: 'https://www.linkedin.com/showcase/microsoftresearch/',
      followers: expect.any(Number),
    });
  });

  test('by id reads the same company', () => {
    const a = parseCompany(BY_NAME);
    const b = parseCompany(BY_ID);
    if (!a.ok || !b.ok) throw new Error('unread');
    expect(b.company.name).toBe('Microsoft');
    expect(b.company.id).toBe(a.company.id);
    expect(b.company.specialties).toEqual(a.company.specialties);
  });

  test('a name that matches no company is not found, not an empty success', () => {
    const none = { data: { ...BY_NAME.data, '*elements': [] }, included: [] };
    const r = parseCompany(none);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_FOUND');
  });

  test('a company listed but not sent is drift', () => {
    const r = parseCompany({ ...BY_NAME, included: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCHEMA_DRIFT');
  });
});
