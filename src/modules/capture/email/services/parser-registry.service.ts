import type { IEmailParser } from '../parsers/parser.interface'

export type ParserRegistryServiceDeps = {
  readonly parsers?: readonly IEmailParser[]
}

export class ParserRegistryService {
  private readonly parserMap = new Map<string, IEmailParser>()

  public constructor(deps?: ParserRegistryServiceDeps) {
    if (deps?.parsers) {
      for (const parser of deps.parsers) {
        this.registerParser(parser)
      }
    }
  }

  public registerParser(parser: IEmailParser): void {
    for (const domain of parser.supportedDomains) {
      this.parserMap.set(domain.toLowerCase().trim(), parser)
    }
  }

  public getParserForDomain(domain: string): IEmailParser | null {
    if (!domain) return null
    return this.parserMap.get(domain.toLowerCase().trim()) ?? null
  }

  public hasParserForDomain(domain: string): boolean {
    if (!domain) return false
    return this.parserMap.has(domain.toLowerCase().trim())
  }
}
