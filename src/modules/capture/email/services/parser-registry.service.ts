import type { IEmailParser } from '../parsers/parser.interface'

export class ParserRegistryService {
  private readonly parsers = new Map<string, IEmailParser>()

  /**
   * Registers a parser instance under its supported domains.
   */
  public registerParser(parser: IEmailParser): void {
    for (const domain of parser.supportedDomains) {
      const normalizedDomain = domain.toLowerCase().trim()
      this.parsers.set(normalizedDomain, parser)
    }
  }

  /**
   * Retrieves a registered parser for a given sender domain.
   */
  public getParserForDomain(domain: string): IEmailParser | null {
    const normalizedDomain = domain.toLowerCase().trim()
    return this.parsers.get(normalizedDomain) ?? null
  }

  /**
   * Checks if a parser is registered for a given sender domain.
   */
  public hasParserForDomain(domain: string): boolean {
    const normalizedDomain = domain.toLowerCase().trim()
    return this.parsers.has(normalizedDomain)
  }
}
