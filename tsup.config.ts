import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'mcp-shim': 'src/mcp-shim.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node18',
  // No code splitting: each entry is self-contained, so the in-source entry
  // guard (`shouldRunAsEntry` in src/entry.ts, inlined into each bundle) resolves
  // import.meta.url against argv[1] via realpath when a bin is run. With splitting
  // on, that guard would live in a shared chunk whose URL never matches argv[1].
  splitting: false,
  sourcemap: true,
  outDir: 'dist',
  async onSuccess() {
    for (const file of ['dist/cli.js', 'dist/mcp-shim.js']) {
      const body = readFileSync(file, 'utf-8');
      if (!body.startsWith('#!')) {
        writeFileSync(file, `#!/usr/bin/env node\n${body}`);
      }
    }
  },
});
