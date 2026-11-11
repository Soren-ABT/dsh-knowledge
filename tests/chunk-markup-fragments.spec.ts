/**
 * Issue #67: markup-only lines (Markdown rules, LaTeX environment/math
 * delimiters, RST/AsciiDoc/Org/HTML separators) must not become standalone
 * chunks, and short fragments must not survive on their own. The filter is
 * intentionally language-agnostic; the minimum-size merge is a separate step
 * so separator removal stays exact.
 */
import { describe, expect, it } from 'vitest'
import { chunkText, splitSemanticSegments } from '../src/knowledge/chunk.js'

const THEMATIC = /^\s*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const LATEX_DELIMITER = /^\s*(?:\${2,}|\\\[|\\\]|\\begin\{[^}]*\}(?:\[[^\]]*\])?(?:\{[^{}]*\})*|\\end\{[^}]*\}|\\hline|\\toprule|\\midrule|\\bottomrule|\\cline\{[^{}]*\})\s*$/

const longParagraph = (label: string): string => `${label}：${'正'.repeat(60)}`

describe('markup fragment chunks (issue #67)', () => {
  it('drops Markdown thematic breaks and keeps the surrounding prose', () => {
    const text = [
      longParagraph('第一段'),
      '---',
      longParagraph('第二段'),
      '***',
      longParagraph('第三段'),
      '___',
      longParagraph('第四段'),
      '- - -',
      longParagraph('第五段'),
    ].join('\n\n')
    const chunks = chunkText(text, 800, 100, { smartChunk: true, separator: '\n\n' })
    expect(chunks.filter(chunk => THEMATIC.test(chunk.text))).toEqual([])
    expect(chunks).toHaveLength(5)
    for (const chunk of chunks) expect(chunk.text.length).toBeGreaterThan(40)
  })

  it('does not touch a setext heading underline', () => {
    const chunks = chunkText('Setext 标题\n---\n\n正文。', 800, 100, { smartChunk: true, separator: '\n\n' })
    expect(chunks.some(chunk => chunk.text === '---')).toBe(false)
    expect(chunks[0]!.text.startsWith('Setext 标题\n---')).toBe(true)
  })

  it('scales to the reported 120 separator blocks', () => {
    const text = Array.from({ length: 120 }, (_, index) => `第 ${index} 段正文。\n\n---`).join('\n\n') + '\n\n结尾段落。'
    const chunks = chunkText(text, 800, 100, { smartChunk: true, separator: '\n\n' })
    expect(chunks.filter(chunk => THEMATIC.test(chunk.text))).toEqual([])
    expect(chunks.map(chunk => chunk.text).join('\n')).toContain('结尾段落。')
  })

  it('merges short blocks but keeps heading sections apart', () => {
    const short = Array.from({ length: 40 }, (_, index) => `短句 ${index}。`).join('\n\n')
    expect(chunkText(short, 800, 100)).toHaveLength(1)

    const sections = '# A\n\n短句一。\n\n# B\n\n短句二。'
    const chunks = chunkText(sections, 800, 100)
    expect(chunks).toHaveLength(2)
    expect(chunks.map(chunk => chunk.heading)).toEqual(['A', 'B'])
  })

  it('leaves long paragraphs as separate chunks', () => {
    const text = [longParagraph('第一段'), longParagraph('第二段')].join('\n\n')
    expect(chunkText(text, 800, 100)).toHaveLength(2)
  })

  it('drops LaTeX math and environment delimiters', () => {
    const tex = [
      String.raw`\documentclass{article}`,
      String.raw`\begin{document}`,
      String.raw`\section{引言}`,
      '正文第一段。',
      '$$',
      'E = mc^2',
      '$$',
      String.raw`\begin{align}`,
      'a &= b + c',
      String.raw`\end{align}`,
      String.raw`\begin{tabular}{cc}`,
      String.raw`\hline`,
      'A & B',
      String.raw`\hline`,
      String.raw`\end{tabular}`,
      String.raw`\end{document}`,
    ].join('\n\n')
    const chunks = chunkText(tex, 800, 100)
    expect(chunks.filter(chunk => LATEX_DELIMITER.test(chunk.text))).toEqual([])
    const joined = chunks.map(chunk => chunk.text).join('\n')
    expect(joined).toContain('E = mc^2')
    expect(joined).toContain('a &= b + c')
    expect(joined).toContain('A & B')
    expect(chunks.every(chunk => chunk.heading === undefined)).toBe(true)
  })

  it('drops the same class of fragments in RST, AsciiDoc, Org and HTML', () => {
    const samples = [
      { text: ['标题', '====', '正文段落。', '----', '另一段。', '.. note::', '   提示内容。'].join('\n\n'), fragments: ['====', '----', '.. note::'] },
      { text: ['= 标题', '正文。', "'''", '|===', '| A | B', '|==='].join('\n\n'), fragments: ["'''", '|==='] },
      { text: ['* 标题', '正文。', '-----', '更多。'].join('\n\n'), fragments: ['-----'] },
      { text: ['<h1>标题</h1>', '<hr>', '正文。'].join('\n\n'), fragments: ['<hr>'] },
    ]
    for (const { text, fragments } of samples) {
      const chunks = chunkText(text, 800, 100)
      for (const fragment of fragments) expect(chunks.some(chunk => chunk.text === fragment)).toBe(false)
    }
    const html = chunkText(['<h1>标题</h1>', '<hr>', '正文。'].join('\n\n'), 800, 100)
    expect(html.map(chunk => chunk.text).join('\n')).toContain('<h1>标题</h1>')
  })

  it('never filters delimiters inside a fenced code block', () => {
    const fenced = ['```text', '---', '', '$$', '```', '', '正文。'].join('\n')
    const chunks = chunkText(fenced, 800, 100)
    const code = chunks.find(chunk => chunk.text.includes('$$'))
    expect(code?.text).toContain('---')
    expect(chunks.some(chunk => chunk.text === '---' || chunk.text === '$$')).toBe(false)
  })

  it('filters separator pieces in delimiter-only mode and semantic segments', () => {
    expect(chunkText('第一段。\n\n---\n\n第二段。', 800, 100, { smartChunk: false, separator: '\n\n' }).map(chunk => chunk.text))
      .toEqual(['第一段。', '第二段。'])
    expect(splitSemanticSegments('第一段。\n\n---\n\n第二段。').map(segment => segment.text))
      .toEqual(['第一段。', '第二段。'])
  })

  it('still returns one chunk for a lone short block', () => {
    expect(chunkText('短。', 800, 100)).toEqual([{ text: '短。' }])
  })
})
