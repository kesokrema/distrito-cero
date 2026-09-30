import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'distrito-tests-'));
try {
  const output = join(directory, 'city-tests.mjs');
  await build({ entryPoints: ['tests/city.test.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  await import(pathToFileURL(output).href);
} finally { await rm(directory, { recursive: true, force: true }); }
