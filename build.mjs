/**
 * Build for dsh-knowledge: three host plugins + one browser client bundle.
 *
 * Host entries compile TypeScript to ESM and keep `@deepseek-ai/*`, `zod`,
 * and the document parsers external — the profile's healed node_modules
 * provides them at runtime (schemastery stays bundled because the Loader
 * validates Config against it).
 *
 * The client bundle is a factory-form classic script: it calls
 * `window.__ModuleLoader__.load({ id, factory })` and resolves externals
 * through the injected `require` (the frozen client module table). Platform
 * modules (react, react/jsx-runtime, cordis, and the shared client UI
 * packages) stay external; everything else is inlined.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ID = 'dsh-knowledge'

mkdirSync('lib', { recursive: true })

// Host: DSH/cordis/zod packages are peer-provided; document parsers are
// runtime dependencies resolved from node_modules. Everything else bundles.
const hostExternal = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-*',
  'zod',
  'pdf-parse',
  'mammoth',
  'jszip',
  'word-extractor',
  '@firecrawl/anydoc',
  '@huggingface/transformers',
  'onnxruntime-node',
]

const hostEntries = [
  ['src/index.ts', 'lib/index.js'],
  ['src/knowledge/index.ts', 'lib/knowledge/index.js'],
  ['src/tool-knowledge/index.ts', 'lib/tool-knowledge/index.js'],
]

for (const [entry, outfile] of hostEntries) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    sourcemap: true,
    external: hostExternal,
    logLevel: 'info',
  })
}

// Client: the platform modules the shell shares into the frozen module table.
const clientExternal = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

await build({
  entryPoints: ['src/ui/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  jsx: 'automatic',
  external: clientExternal,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {\nvar module = { exports: {} };\n`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

// Type declarations for the `exports.types` entries. esbuild strips types, so
// `tsc` emits them separately from the same sources into `lib/types`.
execFileSync(
  process.execPath,
  [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' },
)
