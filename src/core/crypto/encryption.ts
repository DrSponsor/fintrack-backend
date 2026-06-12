import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

export function decodeFieldEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64')
  if (key.byteLength !== 32) {
    throw new Error('Field encryption key must be 32 bytes')
  }
  return key
}

export function encryptField(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

export function decryptField(encoded: string, key: Buffer): string {
  const parts = encoded.split(':')
  const ivPart = parts[0]
  const tagPart = parts[1]
  const ciphertextPart = parts[2]

  if (ivPart === undefined || tagPart === undefined || ciphertextPart === undefined || parts.length !== 3) {
    throw new Error('Encrypted field has invalid format')
  }

  const iv = Buffer.from(ivPart, 'base64')
  const tag = Buffer.from(tagPart, 'base64')
  const ciphertext = Buffer.from(ciphertextPart, 'base64')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
