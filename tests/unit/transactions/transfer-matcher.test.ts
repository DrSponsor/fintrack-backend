import { describe, expect, it, vi } from 'vitest'
import {
  TransferMatcherService,
  TRANSFER_WINDOW_MS,
} from '../../../src/modules/transactions/services/transfer-matcher.service'
import type {
  ITransferRepository,
  TransferCandidate,
  TransferSubject,
} from '../../../src/modules/transactions/services/transfer-matcher.service'

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as never

const AT = new Date('2026-08-28T10:00:00.000Z')

const subject: TransferSubject = {
  id: 'debit-1',
  userId: 'user-1',
  accountId: 'access',
  amountKobo: 5_000_000n,
  type: 'DEBIT',
  transactionDate: AT,
}

function candidate(over: Partial<TransferCandidate> = {}): TransferCandidate {
  return {
    id: 'credit-1',
    accountId: 'opay',
    transactionDate: new Date(AT.getTime() + 40_000),
    transferGroupId: null,
    ...over,
  }
}

function createRepo(overrides: Partial<ITransferRepository> = {}): ITransferRepository {
  return {
    findCounterparts: vi.fn().mockResolvedValue([] as readonly TransferCandidate[]),
    linkAsTransfer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const build = (repo: ITransferRepository) => new TransferMatcherService({ repo, logger: silentLogger })

describe('TransferMatcherService', () => {
  it('links a debit and a credit on two of the user’s own accounts', async () => {
    const repo = createRepo({ findCounterparts: vi.fn().mockResolvedValue([candidate()]) })
    const result = await build(repo).evaluate(subject)

    expect(result.linked).toBe(true)
    expect(repo.linkAsTransfer).toHaveBeenCalledOnce()
  })

  it('gives both sides the same group id', async () => {
    const repo = createRepo({ findCounterparts: vi.fn().mockResolvedValue([candidate()]) })
    await build(repo).evaluate(subject)

    const [a, b, groupId] = vi.mocked(repo.linkAsTransfer).mock.calls[0] ?? []
    expect(a?.id).toBe('debit-1')
    expect(b?.id).toBe('credit-1')
    expect(groupId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('does nothing when there is no counterpart', async () => {
    const repo = createRepo()
    const result = await build(repo).evaluate(subject)

    expect(result.linked).toBe(false)
    expect(repo.linkAsTransfer).not.toHaveBeenCalled()
  })

  it('leaves a counterpart that already belongs to a transfer alone', async () => {
    // Claiming it again would move it between groups and strand its original
    // partner in a group of one.
    const repo = createRepo({
      findCounterparts: vi.fn().mockResolvedValue([candidate({ transferGroupId: 'existing' })]),
    })
    const result = await build(repo).evaluate(subject)

    expect(result.linked).toBe(false)
    if (!result.linked) expect(result.reason).toContain('already part of a transfer')
    expect(repo.linkAsTransfer).not.toHaveBeenCalled()
  })

  it('picks the nearest in time when several could match', async () => {
    // Otherwise the outcome depends on row order, which no user could predict.
    const repo = createRepo({
      findCounterparts: vi.fn().mockResolvedValue([
        candidate({ id: 'far', transactionDate: new Date(AT.getTime() + 9 * 60_000) }),
        candidate({ id: 'near', transactionDate: new Date(AT.getTime() + 30_000) }),
        candidate({ id: 'middling', transactionDate: new Date(AT.getTime() + 4 * 60_000) }),
      ]),
    })
    await build(repo).evaluate(subject)

    expect(vi.mocked(repo.linkAsTransfer).mock.calls[0]?.[1]?.id).toBe('near')
  })

  it('measures nearness in both directions, since the credit can arrive first', async () => {
    const repo = createRepo({
      findCounterparts: vi.fn().mockResolvedValue([
        candidate({ id: 'after', transactionDate: new Date(AT.getTime() + 5 * 60_000) }),
        candidate({ id: 'before', transactionDate: new Date(AT.getTime() - 20_000) }),
      ]),
    })
    await build(repo).evaluate(subject)

    expect(vi.mocked(repo.linkAsTransfer).mock.calls[0]?.[1]?.id).toBe('before')
  })

  it('works the same when the credit is the one that arrived second', async () => {
    // Neither bank is obliged to alert first, so the logic must not assume the
    // debit is seen first.
    const credit: TransferSubject = { ...subject, id: 'credit-2', accountId: 'opay', type: 'CREDIT' }
    const repo = createRepo({
      findCounterparts: vi.fn().mockResolvedValue([candidate({ id: 'debit-2', accountId: 'access' })]),
    })
    const result = await build(repo).evaluate(credit)

    expect(result.linked).toBe(true)
  })

  it('asks the repository for the documented window', async () => {
    // The window is the entire false-positive defence, so it is worth pinning:
    // an hour would silently start matching unrelated same-amount payments.
    const repo = createRepo()
    await build(repo).evaluate(subject)

    expect(repo.findCounterparts).toHaveBeenCalledWith(subject, TRANSFER_WINDOW_MS)
    expect(TRANSFER_WINDOW_MS).toBe(15 * 60 * 1000)
  })

  it('never links a row to itself', async () => {
    // A repository bug returning the subject would otherwise produce a
    // transfer from an account to itself, hiding a genuine transaction.
    const repo = createRepo({
      findCounterparts: vi.fn().mockResolvedValue([candidate({ id: subject.id, accountId: 'access' })]),
    })
    const result = await build(repo).evaluate(subject)

    expect(result.linked).toBe(false)
    expect(repo.linkAsTransfer).not.toHaveBeenCalled()
  })
})
