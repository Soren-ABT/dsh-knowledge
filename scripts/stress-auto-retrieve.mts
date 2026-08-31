/* High-intensity stress test for auto-retrieve: real KnowledgeService + real
 * SQLite chunk store, exercising multi-base retrieval, follow-up context,
 * topic-aware throttle, injection dedup, adaptive thresholds, per-base
 * voting + per-base weights (0 = excluded, 1 = single seat), rerank
 * participation through a fake remote /rerank endpoint, named-base
 * targeting, chunk clipping, and concurrent agents. */
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateContextTokens } from '../src/knowledge/context.js'
import { KnowledgeService } from '../src/knowledge/index.js'
import { autoRetrieveBackground } from '../src/tool-knowledge/index.js'

const BASE_CONFIG = {
  embeddingProvider: 'none', embeddingBaseUrl: '', embeddingModel: '', embeddingApiKey: '',
  rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
  smartChunk: true, chunkSeparator: '\n\n', chunkSize: 1024, chunkOverlap: 200,
  topK: 4, searchMode: 'auto' as const, similarityThreshold: 0, mmrDiversity: 0,
  rrfVectorWeight: 1, embeddingBatchSize: 32, siblingChunks: 1,
  localModelCacheDir: '', hfEndpoint: '', chunkStorePath: '',
  documentProcessorProvider: 'builtin' as const, mineruApiKey: '', mineruApiHost: '',
  semanticChunk: false, semanticChunkThreshold: 0.75, chunkTokenLimit: 0,
  conflictStrategy: 'rename' as const, urlRefreshHours: 0,
  imageCaptionProvider: 'off' as const, imageCaptionModel: '', imageCaptionBaseUrl: '', imageCaptionApiKey: '',
  resumeInterruptedOnStartup: true,
  autoRetrieve: true,
}

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) console.log(`  ✓ ${name}`)
  else { failures += 1; console.error(`  ✗ ${name} ${detail}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'kb-stress-'))
process.env.DSH_HOME = dir
// Keep the fake rerank endpoint direct even when a proxy is configured.
process.env.NO_PROXY = '127.0.0.1,localhost'

async function mount(): Promise<{ service: KnowledgeService; close: () => void }> {
  const ctx = new Context()
  ctx.provide('webServer', { routes: [], register: () => () => {} })
  await ctx.plugin(KnowledgeService, { ...BASE_CONFIG, chunkStorePath: join(dir, 'chunks.sqlite') })
  const service = ctx.get('knowledge') as unknown as KnowledgeService
  return { service, close: () => { /* process exit cleans up */ } }
}

function stubAgent(label: string): { id: string; inject(message: unknown): void; injected: unknown[] } {
  const injected: unknown[] = []
  return { id: `agent-${label}`, inject: (m) => { injected.push(m) }, injected }
}

const textOf = (message: unknown): string =>
  (message as { content: Array<{ text: string }> }).content[0].text

const { service, close } = await mount()
try {
  // ── fixtures: two bases, Chinese + English ─────────────────────────────────
  console.log('fixtures: building 2 bases')
  const zh = await service.createBase({ name: '中文手册' })
  const en = await service.createBase({ name: 'HR Manual' })
  const b64 = (t: string): string => Buffer.from(t).toString('base64')
  // Chinese base: 报销/年假/体检 topics
  await service.addTextDocument({ baseId: zh.id, title: '报销流程', content: '公司的报销流程是提交发票后由直属上级审批，财务在两个工作日内打款。\n\n需要附上发票原件与审批单，金额超过五千元需部门总监二次审批。' })
  await service.addTextDocument({ baseId: zh.id, title: '年假制度', content: '年假申请需要提前三天在系统提交，每年有十五天带薪年假，未休完可顺延至次年三月。' })
  await service.addTextDocument({ baseId: zh.id, title: '体检安排', content: '年度体检安排在每年十一月，公司承担基础套餐费用，家属可自费加项。' })
  // English base
  await service.addFileDocument({ baseId: en.id, fileName: 'onboarding.txt', contentBase64: b64('New hires complete onboarding within 30 days: equipment, access badges, and the security training module.') })
  await service.addFileDocument({ baseId: en.id, fileName: 'expenses.txt', contentBase64: b64('Expense reimbursement requires a receipt and manager approval; finance pays within two business days.') })
  await service.waitForIdle()
  check('fixtures indexed', service.listDocuments(zh.id).length === 3 && service.listDocuments(en.id).length === 2)

  // ── 1. single-base factual question → injects ──────────────────────────────
  console.log('\n1. single-base factual question')
  const a1 = stubAgent('zh')
  await autoRetrieveBackground(service as never, a1 as never, '公司的报销流程是什么？')
  check('injects for a factual question', a1.injected.length === 1)
  if (a1.injected.length > 0) {
    const text = textOf(a1.injected[0])
    check('injected chunk mentions 报销', text.includes('报销'))
    check('injected chunk cites base + title', text.includes('中文手册') && text.includes('报销流程'))
  }

  // ── 2. same-topic follow-up → no duplicate chunk; may add a NEW chunk ──────
  console.log('\n2. same-topic follow-up')
  await autoRetrieveBackground(service as never, a1 as never, '那发票需要什么？')
  check('follow-up injects at most one additional chunk', a1.injected.length <= 2, `got ${a1.injected.length}`)
  if (a1.injected.length === 2) {
    // Two injections must not be the identical chunk text (dedup held).
    check('follow-up added a different chunk, not a duplicate', textOf(a1.injected[0]) !== textOf(a1.injected[1]))
  }

  // ── 3. new topic → injects the new document ────────────────────────────────
  console.log('\n3. new topic')
  await autoRetrieveBackground(service as never, a1 as never, '年假怎么申请？')
  check('new topic injects', a1.injected.length > 0)
  const lastText = a1.injected.length > 0 ? textOf(a1.injected[a1.injected.length - 1]) : ''
  check('last injection covers the 年假 doc', lastText.includes('年假'))

  // ── 4. unrelated chit-chat → nothing ───────────────────────────────────────
  console.log('\n4. unrelated messages')
  const a2 = stubAgent('chat')
  await autoRetrieveBackground(service as never, a2 as never, '你好呀今天天气不错')
  check('chit-chat injects nothing', a2.injected.length === 0)
  await autoRetrieveBackground(service as never, a2 as never, '帮我算一下 23 乘以 47 等于多少')
  check('math question injects nothing', a2.injected.length === 0)

  // ── 5. named-base targeting ────────────────────────────────────────────────
  console.log('\n5. named-base targeting')
  const a3 = stubAgent('named')
  // "HR Manual" named → only that base searched; Chinese base must not leak.
  await autoRetrieveBackground(service as never, a3 as never, '看看 HR Manual 里的 expense reimbursement 流程')
  check('named-base query injects', a3.injected.length === 1)
  if (a3.injected.length > 0) {
    const text = textOf(a3.injected[0])
    check('named-base hit comes from the English base', text.includes('HR Manual') && /receipt|reimbursement/i.test(text))
  }

  // ── 6. cross-base voting ───────────────────────────────────────────────────
  console.log('\n6. cross-base coverage')
  const a4 = stubAgent('multi')
  // "reimbursement" matches both bases' expense docs → expect both bases voted in.
  await autoRetrieveBackground(service as never, a4 as never, 'reimbursement 报销 流程')
  check('cross-base query injects', a4.injected.length === 1)
  if (a4.injected.length > 0) {
    const text = textOf(a4.injected[0])
    check('both bases represented', text.includes('中文手册') && text.includes('HR Manual'), text)
  }

  // ── 7. dedup across time window ────────────────────────────────────────────
  console.log('\n7. dedup across turns')
  const a5 = stubAgent('dedup')
  await autoRetrieveBackground(service as never, a5 as never, '报销流程是什么？')
  expectInjections(a5, 1, 'first injection')
  // A NEW topic (直属上级审批 — no keyword overlap with the first query) whose
  // ONLY lexical match is the very chunk injected in turn 1: the chunk-id
  // dedup must suppress the repeat instead of re-injecting it.
  await autoRetrieveBackground(service as never, a5 as never, '直属上级审批')
  check('same chunk not re-injected', a5.injected.length === 1)

  // ── 8. query-centred long chunk keeps a tail answer under the hard budget ──
  console.log('\n8. query-centred long-chunk evidence')
  const longBase = await service.createBase({ name: '长文库' })
  const tailAnswer = '关键信息：长文档截断测试目标文本。'
  await service.addTextDocument({
    baseId: longBase.id,
    title: '长文',
    content: '这是一段非常长的内容，'.repeat(200) + tailAnswer,
  })
  await service.waitForIdle()
  const a6 = stubAgent('long')
  await autoRetrieveBackground(service as never, a6 as never, '长文档截断测试')
  check('long doc query injects', a6.injected.length === 1)
  if (a6.injected.length > 0) {
    const text = textOf(a6.injected[0])
    const visibleTokens = estimateContextTokens(text)
    check('tail answer remains visible after query-centred clipping', text.includes(tailAnswer), text.slice(-160))
    check('injected background respects the 640-token hard budget', visibleTokens <= 640, `${visibleTokens} tokens`)
  }

  // ── 9. weak match → nothing ────────────────────────────────────────────────
  console.log('\n9. weak match')
  const a7 = stubAgent('weak')
  await autoRetrieveBackground(service as never, a7 as never, '量子物理与弦理论的最新进展')
  check('unrelated technical query injects nothing', a7.injected.length === 0)

  // ── 10. high-frequency hammering (10 rapid messages) ───────────────────────
  console.log('\n10. high-frequency hammering')
  const a8 = stubAgent('hammer')
  const topics = ['报销流程', '年假制度', '体检安排', '报销发票', '年假天数', '体检项目', '报销金额', '年假顺延', '体检家属', '报销审批']
  for (const topic of topics) {
    await autoRetrieveBackground(service as never, a8 as never, `${topic}是什么`)
  }
  // Topic-aware throttle + dedup should cap injections well below 10.
  check('10 rapid messages produce ≤6 injections (throttle+dedup)', a8.injected.length <= 6, `got ${a8.injected.length}`)
  check('at least 2 distinct topics injected', new Set(a8.injected.map(textOf).filter(t => t.length > 0)).size >= 2)

  // ── 11. concurrent agents ──────────────────────────────────────────────────
  console.log('\n11. concurrent agents')
  const agents = Array.from({ length: 8 }, (_, i) => stubAgent(`conc${i}`))
  const queries = ['报销流程', '年假', '体检', 'onboarding', 'expenses', '发票', '审批', 'equipment']
  await Promise.all(agents.map((agent, i) => autoRetrieveBackground(service as never, agent as never, queries[i])))
  const injectedCount = agents.filter(a => a.injected.length > 0).length
  check('concurrent agents complete without throwing', injectedCount >= 0)
  check('at least half of concurrent agents injected relevant background', injectedCount >= 4, `got ${injectedCount}`)

  // ── 12. per-base weight: weight-0 base is excluded end-to-end ───────────────
  // (Contrast with scenario 9: there the topic existed nowhere; here it is a
  // strong lexical match but the only matching base is weight-0 → still nothing.)
  console.log('\n12. per-base weight (0 = excluded)')
  const excluded = await service.createBase({ name: '被排除库', config: { autoRetrieveWeight: 0 } })
  await service.addTextDocument({
    baseId: excluded.id,
    title: '量子物理',
    content: '弦理论与量子引力是当代物理学的核心前沿，涉及额外维度、黑洞信息悖论与全息原理。',
  })
  await service.waitForIdle()
  const a9 = stubAgent('excluded')
  await autoRetrieveBackground(service as never, a9 as never, '量子物理弦理论前沿进展')
  check('weight-0 base contributes nothing', a9.injected.length === 0, `got ${a9.injected.length}`)

  // ── 13. per-base weight: weight-1 base is capped to a single seat ──────────
  // Three projector docs: 明基 clearly leads, 爱普生 is a close runner-up
  // (both pass the adaptive gates). Weight 1 must admit ONLY the leader —
  // while an identical default-weight control base admits both.
  console.log('\n13. per-base weight (1 = single seat)')
  const single = await service.createBase({ name: '单票库', config: { autoRetrieveWeight: 1 } })
  for (const [title, content] of [
    ['明基投影仪', '明基投影仪支持 4K 分辨率，适合会议演示。'],
    ['爱普生投影仪', '爱普生投影仪支持 4K 分辨率，适合会议演示。'],
    ['极米投影仪', '极米投影仪支持 4K 分辨率。'],
  ] as const) {
    await service.addTextDocument({ baseId: single.id, title, content })
  }
  await service.waitForIdle()
  const a10 = stubAgent('seat')
  await autoRetrieveBackground(service as never, a10 as never, '明基 投影仪 4K 分辨率 会议演示')
  check('weight-1 base injects', a10.injected.length === 1, `got ${a10.injected.length}`)
  if (a10.injected.length === 1) {
    const text = textOf(a10.injected[0])
    check('only the leader chunk injected (seat cap drops runner-up)', text.includes('明基') && !text.includes('爱普生'), text.slice(0, 80))
    check('injection cites 单票库', text.includes('单票库'))
  }
  // Control: identical docs under the DEFAULT weight → the gates admit ≥2
  // chunks, proving the single injection above is the cap, not the gates.
  const control = await service.createBase({ name: '对照库' })
  for (const [title, content] of [
    ['明基投影仪', '明基投影仪支持 4K 分辨率，适合会议演示。'],
    ['爱普生投影仪', '爱普生投影仪支持 4K 分辨率，适合会议演示。'],
    ['极米投影仪', '极米投影仪支持 4K 分辨率。'],
  ] as const) {
    await service.addTextDocument({ baseId: control.id, title, content })
  }
  await service.waitForIdle()
  const a11 = stubAgent('control')
  await autoRetrieveBackground(service as never, a11 as never, '明基 投影仪 4K 分辨率 会议演示')
  check('default-weight control injects one bundled message', a11.injected.length === 1, `got ${a11.injected.length}`)
  if (a11.injected.length === 1) {
    const text = textOf(a11.injected[0])
    // One message may bundle several chunks: under the default weight the
    // gates admit BOTH the leader and the close runner-up (≥2 chunks), which
    // proves the single chunk in the weight-1 case is the seat cap at work.
    check('control admits leader and runner-up', text.includes('明基') && text.includes('爱普生'), text.slice(0, 120))
  }

  // ── 14. rerank participation: a fake remote reranker flips the winner ───────
  // The per-base rerank config reaches rerankSettings(); the real rerank.ts
  // client POSTs to the fake endpoint; its scores REPLACE the BM25 order, so
  // the injection must follow the reranker — the BM25 runner-up (0.05 rerank
  // score) is dropped even though it cleared the BM25 floor.
  console.log('\n14. rerank participation (fake remote endpoint)')
  const rerankServer = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      try {
        const payload = JSON.parse(body) as { documents?: string[] }
        const documents = payload.documents ?? []
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          results: documents.map((doc, index) => ({
            index,
            // The fake reranker prefers the doc mentioning 首选词, flipping the
            // BM25 winner so the injection order must follow the rerank scores.
            relevance_score: doc.includes('首选词') ? 0.95 : 0.05,
          })),
        }))
      } catch {
        res.writeHead(400).end()
      }
    })
  })
  await new Promise<void>(resolve => rerankServer.listen(0, '127.0.0.1', resolve))
  const rerankPort = (rerankServer.address() as { port: number }).port
  const rerankBase = await service.createBase({
    name: '重排库',
    config: {
      rerankModel: 'fake-reranker',
      rerankBaseUrl: `http://127.0.0.1:${rerankPort}`,
      rerankApiKey: '',
    },
  })
  await service.addTextDocument({ baseId: rerankBase.id, title: '首选文档', content: '主题甲 相关内容 首选词。' })
  await service.addTextDocument({ baseId: rerankBase.id, title: '次选文档', content: '主题甲 相关内容。' })
  await service.waitForIdle()
  const a12 = stubAgent('rerank')
  await autoRetrieveBackground(service as never, a12 as never, '主题甲 相关内容')
  check('rerank path injects exactly the rerank winner', a12.injected.length === 1, `got ${a12.injected.length}`)
  if (a12.injected.length === 1) {
    const text = textOf(a12.injected[0])
    check('rerank winner (首选词) injected', text.includes('首选词'))
    check('BM25 winner without 首选词 dropped by rerank', !text.includes('次选文档'), text.slice(0, 120))
  }
  rerankServer.close()

  // ── 15. noise/symbol boundary ───────────────────────────────────────────────
  // A trap base holds docs whose words (好的, 12345678) appear in the noise
  // inputs below — a false positive would show up as an injection. Pure
  // symbols, chit-chat, repeated filler, and bare digits must never inject;
  // a short valid query wrapped in symbols still does (no raw-length gate).
  console.log('\n15. noise/symbol boundary')
  const noiseBase = await service.createBase({ name: '噪声库' })
  await service.addTextDocument({ baseId: noiseBase.id, title: '客服常用语', content: '好的，收到，谢谢。请稍等，我马上帮您处理。' })
  await service.addTextDocument({ baseId: noiseBase.id, title: '编号', content: '产品编号 12345678 与 2024-01-01 对应。' })
  await service.waitForIdle()
  const expectNone = async (label: string, input: string): Promise<void> => {
    const agent = stubAgent(`noise-${label}`)
    await autoRetrieveBackground(service as never, agent as never, input)
    check(`${label} injects nothing`, agent.injected.length === 0, `got ${agent.injected.length}`)
  }
  await expectNone('pure symbols', '！！！！！！！！')
  await expectNone('chit-chat', '？？你好啊？？哈哈 今天天气真不错 ！！！')
  await expectNone('repeated filler', '好的好的好的')
  await expectNone('bare digits', '12345678')
  await expectNone('laugh', '哈哈哈哈哈哈哈哈哈')
  const a13 = stubAgent('short-query')
  await autoRetrieveBackground(service as never, a13 as never, '报销流程？')
  check('short symbol-wrapped query still injects', a13.injected.length === 1, `got ${a13.injected.length}`)

  console.log(`\n${checks} checks, ${failures} failed`)
  console.log(failures === 0 ? 'ALL STRESS CHECKS PASSED' : `${failures} STRESS CHECK(S) FAILED`)
} finally {
  close()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)

function expectInjections(agent: { injected: unknown[] }, count: number, label: string): void {
  check(label, agent.injected.length === count, `got ${agent.injected.length}`)
}
