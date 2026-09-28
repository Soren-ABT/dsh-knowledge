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
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ID = 'dsh-knowledge'

mkdirSync('lib', { recursive: true })

/**
 * esbuild stamps inlined module file markers with the source file's path. For
 * files inside this package the path stays relative, but code pulled in from a
 * sibling DSH checkout (schemastery → cosmokit) carries the build machine's
 * absolute path — both in the bundle comments and the sourcemap `sources`.
 * Scrub those to a neutral `dsh/` form so no machine path ships in the tarball
 * (line counts are unchanged, so the maps stay aligned).
 */
async function scrubMachinePaths(outfile) {
  const js = await readFile(outfile, 'utf8')
  const scrubbedJs = js.replace(/^(\s*\/\/\s*)[A-Za-z]:[\\/][^\\/\r\n]*[\\/][^\\/\r\n]*[\\/]/gm, '$1dsh/')
  if (scrubbedJs !== js) await writeFile(outfile, scrubbedJs)
  try {
    const map = JSON.parse(await readFile(`${outfile}.map`, 'utf8'))
    if (Array.isArray(map.sources)) {
      const next = map.sources.map(source =>
        source.startsWith('file:///')
          ? source.replace(/^file:\/\/\/[A-Za-z]:[\\/][^\\/]+[\\/][^\\/]+[\\/]/, 'dsh/')
          : source)
      if (next.some((source, index) => source !== map.sources[index])) {
        map.sources = next
        await writeFile(`${outfile}.map`, JSON.stringify(map))
      }
    }
  } catch {
    // no sourcemap — nothing to scrub
  }
}

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
  'pdfjs-dist',
  'tesseract.js',
  'tesseract.js-core',
  'ppu-paddle-ocr',
  'ppu-ocv',
  '@napi-rs/canvas',
  '@techstark/opencv-js',
  'onnxruntime-node',
  'undici',
  'mupdf',
  'turndown',
]

const hostEntries = [
  ['src/index.ts', 'lib/index.js'],
  ['src/knowledge/index.ts', 'lib/knowledge/index.js'],
  // Managed MinerU deployment controller used by the local release smoke.
  // Kept as a bundled public runtime entry so smoke tests exercise production code.
  ['src/knowledge/mineru-deployment.ts', 'lib/knowledge/mineru-deployment.mjs'],
  ['src/tool-knowledge/index.ts', 'lib/tool-knowledge/index.js'],
  // Local embedding inference process: a separate ESM bundle loaded via
  // child_process IPC, so a native ONNX crash or timeout can be recovered
  // without restarting DSH itself.
  ['src/knowledge/embed-process.ts', 'lib/knowledge/embed-process.mjs'],
  // Local cross-encoder reranking runs in a child process, not the embedding
  // worker, so a hard timeout can terminate it without blocking embeddings or
  // reloading onnxruntime in a replacement worker thread on Linux.
  ['src/knowledge/rerank-process.ts', 'lib/knowledge/rerank-process.mjs'],
  // OCR inference worker: Tesseract.js rethrows worker errors on
  // process.nextTick, so it must run in its own thread (own-worker OCR).
  ['src/knowledge/ocr-worker.ts', 'lib/knowledge/ocr-worker.mjs'],
  // pdf-parse worker: pdf-parse v1 leaks an unhandled rejection when a document
  // fails to load (its unawaited doc.destroy() never runs), which Node 22
  // escalates to a host-level unhandled rejection on every scanned/corrupt PDF.
  // Plain .mjs on purpose: a worker thread is started by Node's own loader, so
  // the same relative URL has to resolve in src/ (tests) and lib/ (runtime).
  ['src/knowledge/pdf-parse-worker.mjs', 'lib/knowledge/pdf-parse-worker.mjs'],
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
  await scrubMachinePaths(outfile)
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
