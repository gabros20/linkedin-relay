import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTACT_INFO_URL, contactInfoBody, parseContactInfo } from '../src/engine/contact-info.ts';

const stream = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');

describe('the contact info request', () => {
  test('the overlay the profile page opens, for that member by public id and name', () => {
    expect(CONTACT_INFO_URL).toContain('ProfileContactDetailsOverlay');
    const body = contactInfoBody('person-1', 'Person', 'One');
    expect(body.clientArguments.payload).toEqual({
      vanityName: 'person-1',
      givenName: 'Person',
      familyName: 'One',
      isVanityNameResolved: true,
    });
    expect(body.isModal).toBe(true);
  });
});

describe('parseContactInfo', () => {
  // Each fixture shows the profile link (dropped: `profile` has it), then the fields below,
  // then a Premium upsell whose own label must not be read as a field.
  test('a connection: email and when you connected', () => {
    const r = parseContactInfo(stream('profile-contact-connection.rsc'));
    expect(r).toEqual({
      ok: true,
      contact: { email: 'person-1@example.com', connectedSince: 'Jan 2, 2024' },
    });
  });

  test('a website: the address behind the safety redirect, and its type', () => {
    const r = parseContactInfo(stream('profile-contact-website.rsc'));
    expect(r).toEqual({
      ok: true,
      contact: { websites: [{ url: 'https://www.example.org/', type: 'Other' }] },
    });
  });

  test('your own: website, email and birthday', () => {
    const r = parseContactInfo(stream('profile-contact-self.rsc'));
    expect(r).toEqual({
      ok: true,
      contact: {
        websites: [{ url: 'example.com', type: 'Personal' }],
        email: 'person-3@example.com',
        birthday: 'January 1',
      },
    });
  });

  test('a field it does not know passes through under its own name', () => {
    const field = (view: string | undefined, label: string, value: string) =>
      (view === undefined ? '' : `{"viewTrackingSpecs":{"viewName":"${view}"},`) +
      `["$","p",null,{"className":"x","children":["${label}"]}],` +
      `{"textProps":{"children":["${value}"]}}`;
    const r = parseContactInfo(
      `"viewName":"profile-contact-info-details-view"${field('contact-phone', 'Phone', '+36 1 234 5678')}` +
        `${field('contact-pager-number', 'Pager', '555')}${field(undefined, 'Joined', 'May 2009')}`,
    );
    expect(r).toEqual({
      ok: true,
      contact: {
        phones: [{ number: '+36 1 234 5678' }],
        pagerNumber: '555',
        other: { Joined: 'May 2009' },
      },
    });
  });

  test('not the contact overlay is drift, not an empty success', () => {
    expect(parseContactInfo('0:null')).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
    expect(
      parseContactInfo('"viewName":"profile-contact-info-details-view" nothing labelled'),
    ).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });
});
