import type { PrismaClient } from '../../../../generated/prisma/client'
import type { IAIProvider } from '../../../../core/ai/ai-provider.interface'
import type { AppLogger } from '../../../../core/logger'
import type { ParsedTransaction } from './parser.interface'
import { parseAmountKobo, cleanText } from './utils'

export type AIUniversalParserDeps = {
  readonly prisma: PrismaClient
  readonly aiProvider: IAIProvider
  readonly logger: AppLogger
}

export class AIUniversalParser {
  private readonly prisma: PrismaClient
  private readonly aiProvider: IAIProvider
  private readonly logger: AppLogger

  public constructor(deps: AIUniversalParserDeps) {
    this.prisma = deps.prisma
    this.aiProvider = deps.aiProvider
    this.logger = deps.logger
  }

  public async parse(
    senderDomain: string,
    subject: string,
    bodyHtml: string,
    bodyText: string,
  ): Promise<{ readonly tx: ParsedTransaction | null; readonly isVerified: boolean }> {
    const text = cleanText(bodyHtml || bodyText)
    const normalizedDomain = senderDomain.toLowerCase().trim()

    // 1. Look up pattern in DB
    const patternRecord = await this.prisma.parserPattern.findUnique({
      where: { senderDomain: normalizedDomain },
    })

    if (patternRecord !== null) {
      const isVerified = patternRecord.status === 'STABLE'
      const patterns = patternRecord.patterns as Record<string, string>
      const tx = this.parseWithPattern(text, patterns)
      
      this.logger.info(
        { senderDomain: normalizedDomain, isVerified, patternId: patternRecord.id },
        'Parsed email using existing AI-generated pattern',
      )
      
      return { tx, isVerified }
    }

    // 2. If no pattern exists, call IAIProvider.generateParserPattern under circuit breaker
    this.logger.info(
      { senderDomain: normalizedDomain },
      'No pattern found. Requesting AI to generate new parser patterns.',
    )

    // Call AI provider (circuit breaker is inside generateParserPattern)
    const generatedPatterns = await this.aiProvider.generateParserPattern(text)

    if (Object.keys(generatedPatterns).length === 0) {
      this.logger.warn(
        { senderDomain: normalizedDomain },
        'AI provider failed to generate patterns or circuit breaker is open',
      )
      return { tx: null, isVerified: false }
    }

    // Attempt to parse the email with the generated patterns
    const tx = this.parseWithPattern(text, generatedPatterns)

    // If parsing succeeds (i.e. amount and merchant found), save to DB with status LEARNING
    if (tx !== null) {
      try {
        await this.prisma.parserPattern.create({
          data: {
            senderDomain: normalizedDomain,
            bankName: this.inferBankName(senderDomain),
            status: 'LEARNING',
            patterns: generatedPatterns,
            aiGenerated: true,
            confirmedByUsers: 0,
            version: 1,
            lastValidated: new Date(),
          },
        })
        this.logger.info(
          { senderDomain: normalizedDomain },
          'Successfully generated and saved new parser pattern in LEARNING status',
        )
      } catch (err) {
        // Handle race conditions where another worker inserted the pattern concurrently
        this.logger.warn(
          { senderDomain: normalizedDomain, err },
          'Failed to save generated parser pattern (likely unique constraint conflict)',
        )
      }
    }

    return { tx, isVerified: false }
  }

  private parseWithPattern(text: string, patterns: Record<string, string>): ParsedTransaction | null {
    try {
      const amountRegexStr = patterns.amountRegex || patterns.amount_kobo
      const typeRegexStr = patterns.typeRegex || patterns.type
      const merchantRegexStr = patterns.merchantRegex || patterns.merchant_name
      const dateRegexStr = patterns.dateRegex || patterns.date
      const balanceRegexStr = patterns.balanceRegex || patterns.balance_kobo

      if (!amountRegexStr) return null

      const amountRegex = new RegExp(amountRegexStr, 'i')
      const amountMatch = text.match(amountRegex)
      if (!amountMatch || !amountMatch[1]) return null
      const amountKobo = parseAmountKobo(amountMatch[1])

      let type: 'DEBIT' | 'CREDIT' = 'DEBIT'
      if (typeRegexStr) {
        const typeRegex = new RegExp(typeRegexStr, 'i')
        const typeMatch = text.match(typeRegex)
        if (typeMatch && typeMatch[1]) {
          const typeVal = typeMatch[1].toUpperCase()
          if (
            typeVal.includes('CREDIT') ||
            typeVal.includes('CR') ||
            typeVal.includes('RECEIVED') ||
            typeVal.includes('INWARD')
          ) {
            type = 'CREDIT'
          }
        }
      }

      let merchantName = 'AI Captured Transaction'
      if (merchantRegexStr) {
        const merchantRegex = new RegExp(merchantRegexStr, 'i')
        const merchantMatch = text.match(merchantRegex)
        if (merchantMatch && merchantMatch[1]) {
          merchantName = merchantMatch[1].trim()
        }
      }

      let transactionDate = new Date()
      if (dateRegexStr) {
        const dateRegex = new RegExp(dateRegexStr, 'i')
        const dateMatch = text.match(dateRegex)
        if (dateMatch && dateMatch[1]) {
          const parsedDate = new Date(dateMatch[1].trim())
          if (!isNaN(parsedDate.getTime())) {
            transactionDate = parsedDate
          }
        }
      }

      let balanceAfterKobo: bigint | undefined = undefined
      if (balanceRegexStr) {
        const balanceRegex = new RegExp(balanceRegexStr, 'i')
        const balanceMatch = text.match(balanceRegex)
        if (balanceMatch && balanceMatch[1]) {
          balanceAfterKobo = parseAmountKobo(balanceMatch[1])
        }
      }

      return {
        amountKobo,
        type,
        merchantName,
        transactionDate,
        balanceAfterKobo,
      }
    } catch (err) {
      this.logger.warn({ err }, 'Error parsing text with patterns')
      return null
    }
  }

  private inferBankName(domain: string): string {
    const part = domain.split('.')[0] ?? 'Unknown'
    return part.charAt(0).toUpperCase() + part.slice(1)
  }
}
