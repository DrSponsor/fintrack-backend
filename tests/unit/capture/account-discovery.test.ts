import { describe, expect, it, vi } from 'vitest'
import {
  AccountDiscoveryService,
  DISCOVERY_SAMPLE_SIZE,
} from '../../../src/modules/capture/email/services/account-discovery.service'
import type { IDiscoveryAIProvider } from '../../../src/modules/capture/email/services/account-discovery.service'

const silentLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
  child: () => silentLogger,
} as never

function build(reply: string | null | Error): {
  service: AccountDiscoveryService
  provider: IDiscoveryAIProvider
} {
  const complete =
    reply instanceof Error ? vi.fn().mockRejectedValue(reply) : vi.fn().mockResolvedValue(reply)
  const provider: IDiscoveryAIProvider = { complete }
  return { service: new AccountDiscoveryService({ aiProvider: provider, logger: silentLogger }), provider }
}

const email = (body: string, senderDomain = 'accessbankplc.com') => ({
  subject: 'Transaction Alert',
  body,
  senderDomain,
})

const ALERT = `Dear John Adebayo Doe,
Your account has been Debited
A/C Number 012******345
Account Name JOHN ADEBAYO DOE`

describe('AccountDiscoveryService', () => {
  it('returns the accounts the model found', async () => {
    const { service } = build(
      '{"accounts":[{"bankName":"Access Bank","accountMask":"012******345","holderName":"JOHN ADEBAYO DOE"}]}',
    )
    const found = await service.discover([email(ALERT)])

    expect(found).toHaveLength(1)
    expect(found[0]).toEqual({
      bankName: 'Access Bank',
      accountMask: '012******345',
      holderName: 'JOHN ADEBAYO DOE',
    })
  })

  it('never sends an unmasked account number to the model', async () => {
    // The bank's own mask must survive or discovery has nothing to report;
    // a full number must not.
    const { service, provider } = build('{"accounts":[]}')
    await service.discover([email('A/C Number 012******345 backup 0123456789')])

    const sent = vi.mocked(provider.complete).mock.calls[0]?.[1] ?? ''
    expect(sent).toContain('012******345')
    expect(sent).not.toContain('0123456789')
  })

  it('offers one entry when many emails describe the same account', async () => {
    const { service } = build(
      '{"accounts":[' +
        '{"bankName":"Access Bank","accountMask":"012******345","holderName":"J D"},' +
        '{"bankName":"Access Bank","accountMask":"012-******-345","holderName":"J D"}]}',
    )
    const found = await service.discover([email(ALERT)])

    expect(found).toHaveLength(1)
  })

  it('discards an account number that is not one', async () => {
    // The dangerous output is a plausible invention: the user does not know
    // their own masked number by heart and cannot catch it.
    const { service } = build(
      '{"accounts":[{"bankName":"Access Bank","accountMask":"see your statement","holderName":null}]}',
    )
    expect(await service.discover([email(ALERT)])).toHaveLength(0)
  })

  it('discards a mask that is only our own redaction handed back', async () => {
    const { service } = build(
      '{"accounts":[{"bankName":"Access Bank","accountMask":"##########","holderName":null}]}',
    )
    expect(await service.discover([email(ALERT)])).toHaveLength(0)
  })

  it('keeps the account when the holder name is unusable, rather than dropping both', async () => {
    // The account number is what identifies it; the name only helps a person
    // recognise it. A bad name is not a reason to hide the account.
    const { service } = build(
      '{"accounts":[{"bankName":"Access Bank","accountMask":"012******345","holderName":"4471"}]}',
    )
    const found = await service.discover([email(ALERT)])

    expect(found).toHaveLength(1)
    expect(found[0]?.holderName).toBeNull()
  })

  it('returns nothing rather than throwing when the model is unavailable', async () => {
    // A failed scan must not block a Gmail connection that otherwise works.
    const { service } = build(new Error('503'))
    expect(await service.discover([email(ALERT)])).toEqual([])
  })

  it('survives an unparseable answer', async () => {
    const { service } = build('I found two accounts for you!')
    expect(await service.discover([email(ALERT)])).toEqual([])
  })

  it('does not call the model at all with no emails', async () => {
    const { service, provider } = build('{"accounts":[]}')
    await service.discover([])
    expect(provider.complete).not.toHaveBeenCalled()
  })

  it('caps how many emails one scan sends', async () => {
    const { service, provider } = build('{"accounts":[]}')
    const many = Array.from({ length: DISCOVERY_SAMPLE_SIZE + 20 }, () => email(ALERT))
    await service.discover(many)

    const sent = vi.mocked(provider.complete).mock.calls[0]?.[1] ?? ''
    expect(sent).toContain(`EMAIL ${DISCOVERY_SAMPLE_SIZE} `)
    expect(sent).not.toContain(`EMAIL ${DISCOVERY_SAMPLE_SIZE + 1} `)
  })
})
