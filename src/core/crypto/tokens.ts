import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'

const tokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  role: z.enum(['user', 'support', 'admin']),
  tier: z.enum(['FREE', 'PRO']),
  subscriptionExpiresAt: z.string().datetime().optional(),
})

export type AccessTokenPayload = z.infer<typeof tokenPayloadSchema>

export async function signAccessToken(
  payload: AccessTokenPayload,
  privateKeyPem: string,
  expiresIn = '15m',
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, 'RS256')
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey)
}

export async function verifyAccessToken(token: string, publicKeyPem: string): Promise<AccessTokenPayload> {
  const publicKey = await importSPKI(publicKeyPem, 'RS256')
  const result = await jwtVerify(token, publicKey, { algorithms: ['RS256'] })
  return tokenPayloadSchema.parse(result.payload)
}
