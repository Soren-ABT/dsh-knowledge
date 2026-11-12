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

  it('keeps a Setext underline with text when a long heading is windowed', () => {
    const text = 'x'.repeat(128) + '🙂' + 'y'.repeat(123) + '\n---'
    const chunks = chunkText(text, 64, 0)
    expect(chunks).toHaveLength(2)
    expect(chunks[1].text).toMatch(/y\n---$/)
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(256)
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
    }
  })

  it('scales to the reported 120 separator blocks', () => {
    const paragraphs = [...Array.from({ length: 120 }, (_, index) => `第 ${index} 段正文。`), '结尾段落。']
    const text = paragraphs.join('\n\n---\n\n')
    const chunks = chunkText(text, 800, 100, { smartChunk: true, separator: '\n\n' })
    expect(chunks.filter(chunk => THEMATIC.test(chunk.text))).toEqual([])
    expect(chunks.map(chunk => chunk.text).join('\n\n')).toBe(paragraphs.join('\n\n'))
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
    expect(chunks.map(chunk => chunk.text).join('\n\n')).toBe([
      String.raw`\documentclass{article}`, String.raw`\section{引言}`, '正文第一段。', 'E = mc^2', 'a &= b + c', 'A & B',
    ].join('\n\n'))
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
      const lines = chunks.flatMap(chunk => chunk.text.split('\n'))
      for (const fragment of fragments) expect(lines).not.toContain(fragment)
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

  const modes = [
    { name: 'smart', split: (text: string) => chunkText(text, 800, 100) },
    { name: 'delimiter', split: (text: string) => chunkText(text, 800, 100, { smartChunk: false }) },
    { name: 'semantic', split: (text: string) => splitSemanticSegments(text, { separator: '\\n\\n' }) },
  ]

  it.each(modes)('preserves literal markers in code before trimming in $name mode', ({ split }) => {
    const input = ['    ---', ' \t***', '___', '````\n---\n````', '正文'].join('\r\n\r\n')
    const indexed = split(input).map(piece => piece.text).join('\n\n')
    expect(indexed).toContain('---')
    expect(indexed).toContain('***')
    expect(indexed).toContain('````\n---\n````')
    expect(indexed.match(/---/g)).toHaveLength(2)
    expect(indexed).not.toContain('___')
  })

  it('keeps semantic fences intact and honours literal separators in delimiter-only mode', () => {
    const code = ['~~~text', 'before', '---', 'after\n~~~'].join('\n\n')
    const text = ['start', code, '---', 'end'].join('\n\n')
    expect(splitSemanticSegments(text, { separator: '\\n\\n' }).map(piece => piece.text))
      .toEqual(['start', code, 'end'])
    expect(chunkText(text, 800, 100, { smartChunk: false }).map(piece => piece.text))
      .toEqual(['start', '~~~text', 'before', '---', 'after\n~~~', 'end'])
    const custom = ['start\n~~~text\nbefore', '---', 'after\n~~~\nend', '---', 'tail'].join('||')
    expect(chunkText(custom, 800, 100, { smartChunk: false, separator: '||' }).map(piece => piece.text))
      .toEqual(['start\n~~~text\nbefore', '---', 'after\n~~~\nend', 'tail'])
  })

  it.each(modes)('preserves authored arguments, element names and mixed symbols in $name mode', ({ split }) => {
    const content = [String.raw`\begin{frame}{Energy budget}`, String.raw`\begin{theorem}[Bayes]`,
      '<hr-widget>', '+-+-', '$$$']
    const markup = [String.raw`\begin{tabular}{cc}`, '<hr class="rule" />', '====', '$$']
    const indexed = split([...content, ...markup, 'end'].join('\n\n')).map(piece => piece.text).join('\n\n')
    expect(indexed).toBe([...content, 'end'].join('\n\n'))
  })

  it('respects repeated heading boundaries and the remaining merge budget', () => {
    const full = 'x'.repeat(240)
    const one = [full, 'a'.repeat(24), 'b'].join('\n\n')
    expect(chunkText('# Same\n' + one + '\n\n# Same\nc', 64, 0))
      .toEqual([full, 'a'.repeat(24) + '\n\nb', 'c'].map(text => ({ text, heading: 'Same' })))
  })

  it('returns no searchable text for markup-only inputs and keeps a heading-only document', () => {
    const rules = Array(5).fill('---')
    const escaped = Array(5).fill('\\---\\').join('\n')
    for (const { split } of modes) {
      expect(split('---\n\n***')).toEqual([])
      expect(split(rules.join('\r\n'))).toEqual([])
      expect(split(rules.join('\n\n'))).toEqual([])
      expect(split(escaped)).toEqual([{ text: escaped }])
    }
    expect(chunkText('---||***', 800, 0, { smartChunk: false, separator: '||' })).toEqual([])
    expect(chunkText('# A title', 800, 0)).toEqual([{ text: '# A title' }])
    expect(chunkText('||', 800, 0, { smartChunk: false, separator: '||' })).toEqual([{ text: '||' }])
  })
})
