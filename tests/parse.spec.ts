import { describe, expect, it } from 'vitest'
import { extractFromHtml, parseDocumentBuffer } from '../src/knowledge/parse.js'

/** Build a minimal, structurally valid single-page PDF with one text line. */
function makePdf(text: string): Buffer {
  const objects: string[] = []
  const add = (body: string): number => {
    objects.push(body)
    return objects.length
  }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`)
  add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`))
  })
  const xrefPos = Buffer.concat(chunks).length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

describe('extractFromHtml', () => {
  it('extracts the title and body text, dropping scripts and styles', () => {
    const html = '<html><head><title>My Title</title><style>.a{color:red}</style></head><body><script>var x=1;</script><p>Hello <b>world</b></p><p>Second para</p></body></html>'
    const result = extractFromHtml(html)
    expect(result.title).toBe('My Title')
    expect(result.text).toBe('Hello world\nSecond para')
  })

  it('decodes numeric character references (decimal and hex)', () => {
    const html = '<p>&#20013;&#25991; &#x4E2D;&#x6587; &#x1F600;</p>'
    expect(extractFromHtml(html).text).toBe('中文 中文 😀')
  })

  it('decodes common named entities', () => {
    const html = '<p>a&mdash;b &nbsp; c&hellip;</p>'
    expect(extractFromHtml(html).text).toBe('a—b c…')
  })

  it('strips HTML comments and collapses whitespace per line', () => {
    const html = '<p>keep <!-- hidden -->  this</p>'
    expect(extractFromHtml(html).text).toBe('keep this')
  })
})

describe('parseDocumentBuffer — PDF', () => {
  it('extracts text from a valid PDF', async () => {
    const pdf = makePdf('Hello PDF World')
    const text = await parseDocumentBuffer(pdf, 'doc.pdf', 'application/pdf')
    expect(text).toContain('Hello PDF World')
  })

  it('rejects a corrupt PDF with a clear error', async () => {
    await expect(parseDocumentBuffer(Buffer.from('this is not a pdf at all %%%'), 'broken.pdf', 'application/pdf'))
      .rejects.toThrow(/PDF parsing failed/)
  })

  it('flags a textless PDF (scanned/image-only) instead of importing garbage', async () => {
    // Valid structure, but the page stream draws nothing indexable. Both
    // engines fail to extract text, so the import must reject either way.
    const pdf = makePdf('')
    await expect(parseDocumentBuffer(pdf, 'scanned.pdf', 'application/pdf'))
      .rejects.toThrow(/no extractable text|PDF parsing failed/)
  })
})
