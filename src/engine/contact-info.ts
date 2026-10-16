// ─── A profile's contact info ─────────────────────────────────────────────────
//
// Captured 2026-10-16. The profile page's "Contact info" link opens an SDUI
// overlay, one POST naming the member by public id and name; the legacy
// identity/profiles/<id>/profileContactInfo answers 410 Gone. The overlay is
// a list of labelled fields, most wrapped in a tracking spec that names the
// field (`contact-email`, `contact-website`, `contact-birthday`); "Connected
// since" has none, so fields are read by tracking name where there is one
// and by label otherwise. Labels are in the session's language. A Premium
// upsell follows the fields and is cut off before reading.
//
// Seen with data: email, websites, birthday, connected since. Phone, address,
// Twitter and messenger fields are read by the names the others use and stay
// unverified until one comes with data; any other field passes through.

import type { Failure } from './sdui-form.ts';

const SCREEN = 'com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay';
export const CONTACT_INFO_URL = `https://www.linkedin.com/flagship-web/rsc-action/actions/navigation?screenId=${SCREEN}&sduiid=${SCREEN}`;

export function contactInfoBody(publicId: string, firstName: string, lastName: string) {
  return {
    clientArguments: {
      $type: 'proto.sdui.actions.requests.RequestedArguments',
      requestedStateKeys: [],
      payload: {
        vanityName: publicId,
        givenName: firstName,
        familyName: lastName,
        isVanityNameResolved: true,
      },
      requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
      states: [],
      screenId: SCREEN,
      knownTemplateIds: [],
    },
    isModal: true,
  };
}

export interface ContactInfo {
  email?: string;
  phones?: { number: string; type?: string }[];
  websites?: { url: string; type?: string }[];
  twitter?: string[];
  address?: string;
  birthday?: string;
  connectedSince?: string;
  /** Labelled fields with no tracking name, by their label. */
  other?: Record<string, string>;
  [field: string]: unknown;
}

const drift = (message: string): Failure => ({ ok: false, code: 'SCHEMA_DRIFT', message });
const unquote = (s: string) => JSON.parse(`"${s}"`) as string;

const LABEL = /\["\$","p",null,\{"className":"[^"]*","children":\["((?:[^"\\]|\\.)+)"\]\}\]/g;
const VIEW = /"viewName":"contact-([a-z-]+)"/g;
const LINK = /"urlValue":\{"\$case":"url","url":"((?:[^"\\]|\\.)+)"/g;
const TEXT = /"children":\["((?:[^"\\$]|\\.)(?:[^"\\]|\\.)*)"\]/g;
const TYPE = /"\(([^"()]+)\)"/g;

interface Field {
  label: string;
  view?: string;
  links: string[];
  texts: string[];
  types: string[];
}

/** Where a link goes: past LinkedIn's safety redirect and a mailto/tel scheme. */
function target(link: string): string {
  const url = unquote(link);
  const away = url.match(/\/safety\/go\/?\?url=([^&]+)/)?.[1];
  if (away !== undefined) return decodeURIComponent(away);
  return url.replace(/^(mailto|tel):/, '');
}

function fieldsOf(stream: string): Field[] {
  const start = stream.indexOf('profile-contact-info-details-view');
  const upsell = stream.indexOf('"viewName":"premium-upsell-card"', start);
  const region = stream.slice(start, upsell === -1 ? undefined : upsell);
  const labels = [...region.matchAll(LABEL)];
  const fields: Field[] = [];
  let before = 0;
  labels.forEach((m, i) => {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const seg = region.slice(end, labels[i + 1]?.index ?? region.length);
    const view = [...region.slice(before, at).matchAll(VIEW)].pop()?.[1];
    fields.push({
      label: unquote(m[1] as string).trim(),
      view,
      links: [...seg.matchAll(LINK)].map((l) => target(l[1] as string)),
      texts: [...seg.matchAll(TEXT)].map((t) => unquote(t[1] as string).trim()),
      types: [...seg.matchAll(TYPE)].map((t) => t[1] as string),
    });
    before = end;
  });
  return fields;
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function put(contact: ContactInfo, f: Field): void {
  const text = f.texts.join(', ');
  switch (f.view) {
    case 'your-profile':
      return; // `profile` already has the profile URL.
    case 'email':
      contact.email = f.links[0] ?? text;
      return;
    case 'website':
      contact.websites = [
        ...(contact.websites ?? []),
        ...f.links.map((url, i) => (f.types[i] ? { url, type: f.types[i] } : { url })),
      ];
      return;
    case 'phone':
      contact.phones = [
        ...(contact.phones ?? []),
        ...f.texts.map((number, i) => (f.types[i] ? { number, type: f.types[i] } : { number })),
      ];
      return;
    case 'twitter':
      contact.twitter = [...(contact.twitter ?? []), ...f.texts];
      return;
    case undefined:
      if (/^connected since$/i.test(f.label)) contact.connectedSince = text;
      else contact.other = { ...contact.other, [f.label]: text };
      return;
    default:
      contact[camel(f.view)] = text;
  }
}

export function parseContactInfo(stream: string): { ok: true; contact: ContactInfo } | Failure {
  if (!stream.includes('profile-contact-info-details-view'))
    return drift('the contact info answer was not the contact info overlay');
  const fields = fieldsOf(stream);
  if (fields.length === 0) return drift('the contact info overlay had no fields');
  const contact: ContactInfo = {};
  for (const f of fields) put(contact, f);
  return { ok: true, contact };
}
