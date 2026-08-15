/** Minimal type declaration for the typeless CommonJS `word-extractor` package. */
declare module 'word-extractor' {
  export default class WordExtractor {
    extract(source: Buffer | string): Promise<{ getBody(): string }>
  }
}
