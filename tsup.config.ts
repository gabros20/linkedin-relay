import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'mcp-shim': 'src/mcp-shim.ts',
  },
  format: ['esm'],
  // Declaration generation is off: tsup's dts step crashes against current
  // TypeScript ("useCaseSensitiveFileNames"), and the shipped artefacts are two
  // executables, not a types package. Re-enable if this ever becomes a library.
  dts: false,
  clean: true,
  target: 'node18',
  // No code splitting: each entry is self-contained, so the in-source entry
  // guard (`shouldRunAsEntry` in src/entry.ts, inlined into each bundle) resolves
  // import.meta.url against argv[1] via realpath when a bin is run. With splitting
  // on, that guard would live in a shared chunk whose URL never matches argv[1].
  splitting: false,
  // bun:sqlite is a Bun builtin — it cannot be bundled, and the binaries run
  // under Bun (see the shebang and package.json engines). Marking it external
  // leaves the import for the runtime to resolve.
  external: ['bun:sqlite'],
  sourcemap: true,
  outDir: 'dist',
  async onSuccess() {
    for (const file of ['dist/cli.js', 'dist/mcp-shim.js']) {
      const body = readFileSync(file, 'utf-8');
      if (!body.startsWith('#!')) {
        writeFileSync(file, `#!/usr/bin/env bun\n${body}`);
      }
    }
  },
});
