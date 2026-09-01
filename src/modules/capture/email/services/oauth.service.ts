import CircuitBreaker from 'opossum'
import type { AppConfig } from '../../../../config'
import type { IGmailConnectionRepository } from '../repositories/gmail-connection.repo'
import { decryptField, encryptField, decodeFieldEncryptionKey } from '../../../../core/crypto/encryption'
import type { AppLogger } from '../../../../core/logger'
import { AppError } from '../../../../core/errors/AppError'
import { ERROR_CODES } from '../../../../core/errors/codes'
import { tokenRevoked, validationError } from '../../../../core/errors/factories'

export type GmailTokenPayload = {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly expiryDate: number
}

export class OAuthService {
  private readonly config: AppConfig
  private readonly connectionRepo: IGmailConnectionRepository
  private readonly logger: AppLogger
  private readonly encryptionKey: Buffer
  private readonly breaker: CircuitBreaker<[string, RequestInit], Response>

  public constructor(config: AppConfig, connectionRepo: IGmailConnectionRepository, logger: AppLogger) {
    this.config = config
    this.connectionRepo = connectionRepo
    this.logger = logger
    this.encryptionKey = decodeFieldEncryptionKey(config.fieldEncryptionKeyBase64)

    this.breaker = new CircuitBreaker(
      this.fetchGoogle.bind(this),
      {
        timeout: 10000, // 10 seconds timeout
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    )
  }

  private async fetchGoogle(url: string, options: RequestInit): Promise<Response> {
    const response = await fetch(url, options)
    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error')
      throw new Error(`Google API error [${response.status}]: ${text}`)
    }
    return response
  }

  /**
   * Builds the Google consent URL.
   *
   * `state` is required rather than optional. An OAuth authorization request
   * without it has no way to prove the redirect it later receives belongs to
   * the request it made, and making the parameter optional is the reliable way
   * to end up with a caller that omits it.
   */
  public getConsentUrl(state: string): string {
    const clientId = this.config.googleClientId ?? ''
    const redirectUri = this.config.googleRedirectUri ?? ''
    const scope = encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email')
    
    return `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `scope=${scope}&` +
      `access_type=offline&` +
      `prompt=consent&` +
      // Echoed back untouched by Google on the redirect. The client generates
      // it, holds it, and rejects any redirect whose state does not match.
      `state=${encodeURIComponent(state)}`
  }

  public async exchangeCodeAndSave(userId: string, code: string): Promise<{ readonly email: string }> {
    const clientId = this.config.googleClientId
    const clientSecret = this.config.googleClientSecret
    const redirectUri = this.config.googleRedirectUri

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error('Google OAuth is not fully configured')
    }

    let tokenResponse: Response
    try {
      tokenResponse = await this.breaker.fire('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      })
    } catch (err) {
      this.logger.error({ err }, 'Google OAuth code exchange failed or timed out')
      throw validationError('Failed to exchange authorization code with Google')
    }

    const tokenJson = await tokenResponse.json() as {
      readonly access_token?: string
      readonly refresh_token?: string
      readonly expires_in?: number
    }

    const accessToken = tokenJson.access_token
    if (!accessToken) {
      throw validationError('Google token exchange did not return an access token')
    }

    // Fetch user info to verify the email
    let userInfoResponse: Response
    try {
      userInfoResponse = await this.breaker.fire('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
    } catch (err) {
      this.logger.error({ err }, 'Failed to retrieve user info from Google or timed out')
      throw validationError('Failed to retrieve user info from Google')
    }

    const userInfo = await userInfoResponse.json() as {
      readonly email?: string
    }

    const email = userInfo.email
    if (!email) {
      throw validationError('Google user info did not return an email address')
    }

    // Keep existing refresh token if Google didn't return a new one (e.g. on reconnect without full consent screen bypass)
    const existing = await this.connectionRepo.findByUserId(userId)
    const existingTokenEnc = existing?.tokenEnc ?? null
    let existingRefreshToken: string | null = null
    if (existingTokenEnc) {
      try {
        const decrypted = decryptField(existingTokenEnc, this.encryptionKey)
        const parsed = JSON.parse(decrypted) as GmailTokenPayload
        existingRefreshToken = parsed.refreshToken
      } catch (err) {
        this.logger.warn({ userId, err }, 'Failed to decrypt or parse existing tokens during code exchange')
      }
    }

    const refreshToken = tokenJson.refresh_token || existingRefreshToken
    if (!refreshToken) {
      throw validationError('Gmail connection requires offline access. Please revoke the app consent and try again.')
    }

    const payload: GmailTokenPayload = {
      accessToken,
      refreshToken,
      expiryDate: Date.now() + (tokenJson.expires_in ?? 3600) * 1000,
    }

    const encrypted = encryptField(JSON.stringify(payload), this.encryptionKey)
    // The address Google authorised, not the one the user signed up with.
    await this.connectionRepo.upsert({ userId, emailAddress: email, tokenEnc: encrypted })

    return { email }
  }

  public async getValidAccessToken(userId: string): Promise<string> {
    const connection = await this.connectionRepo.findByUserId(userId)
    const tokenEnc = connection?.tokenEnc ?? null
    if (!tokenEnc) {
      throw tokenRevoked('Gmail connection has not been set up or was disconnected')
    }

    let payload: GmailTokenPayload
    try {
      const decrypted = decryptField(tokenEnc, this.encryptionKey)
      payload = JSON.parse(decrypted) as GmailTokenPayload
    } catch (err) {
      this.logger.error({ userId, err }, 'Failed to decrypt or parse stored Gmail tokens')
      throw tokenRevoked('Failed to decrypt stored credentials')
    }

    // If token is still valid (with a 60-second safety buffer), return it
    if (payload.expiryDate - 60000 > Date.now()) {
      return payload.accessToken
    }

    // Otherwise, refresh the token
    const refreshToken = payload.refreshToken
    if (!refreshToken) {
      throw tokenRevoked('No refresh token available to refresh Gmail access')
    }

    const clientId = this.config.googleClientId
    const clientSecret = this.config.googleClientSecret

    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth is not fully configured')
    }

    let refreshResponse: Response
    try {
      refreshResponse = await this.breaker.fire('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      })
    } catch (err: unknown) {
      this.logger.error({ err, userId }, 'Google OAuth token refresh failed or timed out')

      // Revoked or invalid: the grant is gone, so the row goes with it.
      const message = err instanceof Error ? err.message : ''
      if (message.includes('[400]') || message.includes('[401]')) {
        await this.connectionRepo.remove(userId)
        throw tokenRevoked('Gmail connection was revoked by the user or has expired')
      }

      throw new AppError(
        ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        'Failed to refresh Google OAuth token',
        503,
      )
    }

    const refreshJson = await refreshResponse.json() as {
      readonly access_token?: string
      readonly expires_in?: number
    }

    const newAccessToken = refreshJson.access_token
    if (!newAccessToken) {
      throw new AppError(
        ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        'Google token refresh response was missing access token',
        503,
      )
    }

    const updatedPayload: GmailTokenPayload = {
      accessToken: newAccessToken,
      refreshToken,
      expiryDate: Date.now() + (refreshJson.expires_in ?? 3600) * 1000,
    }

    const encrypted = encryptField(JSON.stringify(updatedPayload), this.encryptionKey)
    // saveToken, not upsert: Google rotates the refresh token routinely, and
    // upsert would clear the sync cursor and turn every rotation into a full
    // re-scan of the mailbox.
    await this.connectionRepo.saveToken(userId, encrypted)

    return newAccessToken
  }

  public async disconnect(userId: string): Promise<void> {
    const connection = await this.connectionRepo.findByUserId(userId)
    const tokenEnc = connection?.tokenEnc ?? null
    if (tokenEnc) {
      try {
        const decrypted = decryptField(tokenEnc, this.encryptionKey)
        const payload = JSON.parse(decrypted) as GmailTokenPayload
        
        // Attempt to revoke the token from Google side (best effort)
        const tokenToRevoke = payload.refreshToken ?? payload.accessToken
        await this.breaker.fire('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ token: tokenToRevoke }),
        }).catch((err) => {
          this.logger.warn({ userId, err }, 'Failed to revoke token on Google servers during disconnect')
        })
      } catch (err) {
        this.logger.warn({ userId, err }, 'Error during disconnect token decryption')
      }
    }

    // One delete, whatever the account count. This used to be one write per
    // connected account, any of which could fail and leave a live token behind.
    await this.connectionRepo.remove(userId)
  }
}
