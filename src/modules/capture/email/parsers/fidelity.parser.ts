import type { IEmailParser, ParsedTransaction } from './parser.interface'
import { parseAmountKobo, cleanText } from './utils'

export class FidelityParser implements IEmailParser {
  public readonly parserId = '6ba7b810-9dad-11d1-80b4-00c04fd430ca'
  public readonly bankName = 'Fidelity Bank'
  public readonly supportedDomains = ['fidelitybank.ng'] as const

  public async parse(subject: string, bodyHtml: string, bodyText: string): Promise<ParsedTransaction | null> {
    const text = cleanText(bodyHtml || bodyText)
    if (!text.toLowerCase().includes('fidelity') && !subject.toLowerCase().includes('fidelity')) {
      return null
    }

    const amountMatch = text.match(/(?:Amount|Amt)\s*:\s*(?:NGN|₦)?\s*([0-9,]+\.[0-9]{2})/i)
    if (!amountMatch || !amountMatch[1]) return null
    const amountKobo = parseAmountKobo(amountMatch[1])

    let type: 'DEBIT' | 'CREDIT' = 'DEBIT'
    if (/credit|cr/i.test(text) && !/debit|dr/i.test(text)) {
      type = 'CREDIT'
    } else if (subject.toLowerCase().includes('credit') || subject.toLowerCase().includes('inward')) {
      type = 'CREDIT'
    }

    const descMatch = text.match(/(?:Narration|Description|Remarks?|Narrative)\s*:\s*([^;.]+)/i)
    const merchantName = descMatch && descMatch[1] ? descMatch[1].trim() : 'Fidelity Bank Transaction'

    const dateMatch = text.match(/(?:Date)\s*:\s*([0-9a-zA-Z-\s:]+)/i)
    const transactionDate = dateMatch && dateMatch[1] ? new Date(dateMatch[1].trim()) : new Date()

    const balanceMatch = text.match(/(?:Balance|Avail Bal)\s*:\s*(?:NGN|₦)?\s*([0-9,]+\.[0-9]{2})/i)
    const balanceAfterKobo = balanceMatch && balanceMatch[1] ? parseAmountKobo(balanceMatch[1]) : undefined

    return {
      amountKobo,
      type,
      merchantName,
      transactionDate: isNaN(transactionDate.getTime()) ? new Date() : transactionDate,
      balanceAfterKobo,
    }
  }
}
