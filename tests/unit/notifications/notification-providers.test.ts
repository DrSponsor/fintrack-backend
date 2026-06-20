import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { FcmProvider } from '../../../src/modules/notifications/providers/fcm.provider'
import { PostmarkProvider } from '../../../src/modules/notifications/providers/postmark.provider'
import { AppError } from '../../../src/core/errors/AppError'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as any

describe('FcmProvider', () => {
  let fetchSpy: any

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to mock logger when credentials are not configured', async () => {
    const provider = new FcmProvider(silentLogger, {})
    await provider.sendPush({ token: 'mock-token', title: 'Test', body: 'Hello' })
    
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(silentLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { token: 'mock-token', title: 'Test', body: 'Hello' },
      }),
      expect.stringContaining('[MOCK FCM]')
    )
  })

  it('attempts real network request when credentials are provided', async () => {
    const provider = new FcmProvider(silentLogger, {
      projectId: 'test-project',
      clientEmail: 'test@client.iam.gserviceaccount.com',
      privateKey,
    })

    // Mock OAuth token exchange
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'fake-access-token', expires_in: 3600 }),
    } as Response)

    // Mock FCM send request
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: 'projects/test-project/messages/123' }),
    } as Response)

    await provider.sendPush({ token: 'device-token', title: 'Hello', body: 'World' })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    
    // First call: OAuth Token
    const oauthUrl = fetchSpy.mock.calls[0][0]
    expect(oauthUrl).toBe('https://oauth2.googleapis.com/token')

    // Second call: FCM Send
    const fcmUrl = fetchSpy.mock.calls[1][0]
    expect(fcmUrl).toBe('https://fcm.googleapis.com/v1/projects/test-project/messages:send')
    
    const fcmOptions = fetchSpy.mock.calls[1][1]
    expect(fcmOptions.headers['Authorization']).toBe('Bearer fake-access-token')
  })

  it('triggers circuit breaker and throws dependencyUnavailable when API fails repeatedly', async () => {
    const provider = new FcmProvider(silentLogger, {
      projectId: 'test-project',
      clientEmail: 'test@client.iam.gserviceaccount.com',
      privateKey,
    })

    // Fail OAuth exchange or FCM API
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Error',
    } as Response)

    // Fire multiple times to trip breaker
    for (let i = 0; i < 10; i++) {
      try {
        await provider.sendPush({ token: 'device-token', title: 'Hi', body: 'Fail' })
      } catch (err) {
        expect(err).toBeInstanceOf(AppError)
      }
    }

    // Circuit breaker should now throw directly without invoking fetch
    const preCallCount = fetchSpy.mock.calls.length
    await expect(
      provider.sendPush({ token: 'device-token', title: 'Hi', body: 'Fail' })
    ).rejects.toThrow('Push notification service is temporarily unavailable')

    // No extra fetch call should occur because the breaker is OPEN
    expect(fetchSpy.mock.calls.length).toBe(preCallCount)
  })
})

describe('PostmarkProvider', () => {
  let fetchSpy: any

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to mock logger when server token is missing', async () => {
    const provider = new PostmarkProvider(silentLogger, 'no-reply@fintrack.ng')
    await provider.sendEmail({ to: 'user@fintrack.ng', subject: 'Alert', htmlBody: '<p>Hi</p>' })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(silentLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'no-reply@fintrack.ng',
        to: 'user@fintrack.ng',
        subject: 'Alert',
      }),
      expect.stringContaining('[MOCK POSTMARK]')
    )
  })

  it('issues real email request to Postmark API when token is provided', async () => {
    const provider = new PostmarkProvider(silentLogger, 'no-reply@fintrack.ng', 'real-server-token')

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Message: 'OK', ErrorCode: 0 }),
    } as Response)

    await provider.sendEmail({ to: 'user@fintrack.ng', subject: 'Alert', htmlBody: '<p>Hi</p>' })

    expect(fetchSpy).toHaveBeenCalledOnce()
    const url = fetchSpy.mock.calls[0][0]
    const options = fetchSpy.mock.calls[0][1]

    expect(url).toBe('https://api.postmarkapp.com/email')
    expect(options.headers['X-Postmark-Server-Token']).toBe('real-server-token')
    expect(options.headers['Content-Type']).toBe('application/json')
    
    const body = JSON.parse(options.body)
    expect(body.From).toBe('no-reply@fintrack.ng')
    expect(body.To).toBe('user@fintrack.ng')
    expect(body.Subject).toBe('Alert')
    expect(body.HtmlBody).toBe('<p>Hi</p>')
  })
})
