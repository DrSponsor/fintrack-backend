const KOBO_PATTERN = /^-?\d+$/

export type KoboString = `${bigint}`

export function serializeKobo(amountKobo: bigint): KoboString {
  return amountKobo.toString() as KoboString
}

export function parseKobo(value: string): bigint {
  if (!KOBO_PATTERN.test(value)) {
    throw new Error('Kobo value must be a base-10 integer string')
  }
  return BigInt(value)
}

export const koboJsonSchema = {
  type: 'string',
  pattern: '^-?\\d+$',
} as const
