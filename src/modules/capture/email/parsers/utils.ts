export function parseAmountKobo(amountStr: string): bigint {
  const normalized = amountStr.replace(/[^0-9.]/g, '')
  const parts = normalized.split('.')
  const majorStr = parts[0] ? parts[0] : '0'
  const major = BigInt(majorStr)
  const minorStr = parts[1] ? parts[1].slice(0, 2).padEnd(2, '0') : '00'
  const minor = BigInt(minorStr)
  return major * 100n + minor
}

export function cleanText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
