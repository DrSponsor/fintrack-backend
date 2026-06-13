import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'

const tokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['user', 'support', 'admin']),
  tier: z.enum(['FREE', 'PRO']),
  sid: z.string().uuid().optional(),
  subscriptionExpiresAt: z.string().datetime().optional(),
})

export type AccessTokenPayload = z.infer<typeof tokenPayloadSchema>

const JWT_ISSUER = 'fintrack-api'

export async function signAccessToken(
  payload: AccessTokenPayload,
  privateKeyPem: string,
  expiresIn = '15m',
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, 'RS256')
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(payload.sub)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey)
}

export async function verifyAccessToken(token: string, publicKeyPem: string): Promise<AccessTokenPayload> {
  const publicKey = await importSPKI(publicKeyPem, 'RS256')
  const result = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: JWT_ISSUER,
  })
  return tokenPayloadSchema.parse(result.payload)
}
