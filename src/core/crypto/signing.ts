import { createHmac, timingSafeEqual } from 'node:crypto'

export function hmacSha256Hex(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

export function verifyHmacSha256(rawBody: Buffer, secret: string, suppliedHex: string): boolean {
  const expected = Buffer.from(hmacSha256Hex(rawBody, secret), 'hex')
  const supplied = Buffer.from(suppliedHex, 'hex')

  if (expected.byteLength !== supplied.byteLength) {
    return false
  }

  return timingSafeEqual(expected, supplied)
}
