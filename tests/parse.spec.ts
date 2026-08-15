import { describe, expect, it } from 'vitest'
import { extractFromHtml } from '../src/knowledge/parse.js'

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
