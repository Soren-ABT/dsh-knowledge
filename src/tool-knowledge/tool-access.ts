import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgeService } from '../knowledge/index.js'
import { ensureWellFormed } from '../knowledge/text-safety.js'

export function knowledgeDestructiveApprovalReason(name: string): string | undefined {
  if (name === 'knowledge_delete_base') return 'Delete this knowledge base and all of its documents permanently?'
  if (name === 'knowledge_delete_document') return 'Delete this knowledge-base document permanently?'
  return undefined
}

export function requireBaseEnabled(knowledge: KnowledgeService, baseId: string): void {
  const scope = knowledge.enabledScope()
  if (scope !== undefined && !scope.includes(baseId)) {
    throw new Error(`knowledge base "${baseId}" is not enabled`)
  }
}

export function requireDocumentEnabled(knowledge: KnowledgeService, documentId: string) {
  const document = knowledge.getDocument(documentId, { includeChunks: false })
  requireBaseEnabled(knowledge, document.baseId)
  return document
}

export function registerToolAccess(ctx: Context): void {
  const knowledge = ctx.knowledge
  // Search guidance lives in the tool description. This optional section only
  // supplies base names, which the tool schema cannot know at registration.
  ctx.systemPrompt.section({
    name: 'knowledge:usage',
    order: 110,
    text: () => {
      if (!knowledge.isEnabled()) return ''
      const bases = knowledge.resolveInvocationScope().enabled.filter(base => knowledge.getConfigFor(base.id).injectUsagePrompt !== false)
      if (bases.length === 0) return ''
      const names = bases.map(base => base.name).join(', ')
      return ensureWellFormed('Available knowledge bases: ' + names + '.')
    },
  })

  // Invocation switch: when knowledge is disabled in the panel, every
  // knowledge_* tool is denied (Cherry's kb_* `applies` gate equivalent).
  ctx.tools.guard((exec) => {
    if (!exec.name.startsWith('knowledge_')) return undefined
    if (!knowledge.isEnabled()) return 'knowledge base invocation is turned off; enable it in the knowledge panel first'
    return undefined
  })

  // Permanent deletion always requires a one-shot user decision. The tools
  // runtime fails closed when no approval channel is mounted.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    const reason = knowledgeDestructiveApprovalReason(exec.name)
    if (reason !== undefined) return { kind: 'ask', reason }
    return decision
  })
}
