#!/usr/bin/env bun
// Freeze the hand-written SKILL.md into a TypeScript string constant so it
// ships inside the npm package rather than depending on the repo being present.
//
// The skill is NOT generated from the command registry — it is prose, and prose
// written by a generator reads like it. What IS mechanical is the check that
// the two agree: tests/skill.test.ts asserts every registry command appears in
// SKILL.md and every command documented in SKILL.md exists in the registry.
// R5 notes the sibling projects leave that agreement to process; here it fails
// CI instead.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCE = join(import.meta.dir, '..', '.claude', 'skills', 'linkedin-relay', 'SKILL.md');
const TARGET = join(import.meta.dir, '..', 'src', 'generated', 'skill.ts');

const markdown = readFileSync(SOURCE, 'utf-8');

const body = `// GENERATED FILE — do not edit.
// Source: .claude/skills/linkedin-relay/SKILL.md
// Regenerate: bun run generate

export const SKILL_MD = ${JSON.stringify(markdown)};
`;

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, body);
console.log(`generated ${TARGET} (${markdown.length} chars)`);
