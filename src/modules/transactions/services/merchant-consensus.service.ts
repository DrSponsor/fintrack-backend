import type { AppLogger } from '../../../core/logger'

/**
 * Promotes a merchant category into the SHARED map once enough separate users
 * have independently agreed on it.
 *
 * ── What counts as evidence ──────────────────────────────────────────────
 * DISTINCT USERS, never correction counts. `userMerchantPreference` carries a
 * `correctionCount`, and it is tempting to read a high one as confidence — but
 * it records how many times ONE person corrected the same merchant, which is
 * one opinion repeated, not corroboration. Worse, trusting it would let a
 * single user rewrite the map every other user reads simply by correcting the
 * same row three times.
 *
 * The table has a unique constraint on (userId, merchantFingerprint), so one
 * row per user per merchant. Counting rows per fingerprint therefore counts
 * distinct people by construction.
 *
 * ── Agreement is not the same as a majority of one ───────────────────────
 * Three users agreeing means little if four others disagree. A merchant where
 * people genuinely categorise differently — a supermarket that also sells fuel
 * — should stay unmapped and let each person's own preference win. So the
 * leading category must hold a strict majority, not merely the most votes.
 *
 * ── What is never promoted ───────────────────────────────────────────────
 * Transfers. A `transfers` category means the counterparty is an individual,
 * and a global row would put a private person's name in a table every account
 * reads. It is also meaningless when shared: the category describes a
 * relationship, not a business. Same rule as CategorizerService.mayShare.
 *
 * Seeded mappings are never overwritten either. Those are deliberate curation;
 * a crowd disagreeing with one is worth investigating, not silently reversing.
 * An AI-generated mapping, by contrast, SHOULD be overturned by real users —
 * that is the whole point, and it is how a wrong guess gets corrected for
 * everyone rather than being worked around by each person separately.
 */

/** Distinct users who must agree before a mapping becomes shared. */
export const CONSENSUS_THRESHOLD = 3

export type CategoryVote = {
  readonly categoryId: string
  /** Distinct users who chose this category for this merchant. */
  readonly users: number
}

export type ExistingMapping = {
  readonly categoryId: string
  readonly source: 'SEEDED' | 'USER_CORRECTION' | 'AI_CONFIRMED'
}

export interface IConsensusRepository {
  /** One entry per category chosen for this fingerprint, with distinct-user counts. */
  tallyPreferences(fingerprint: string): Promise<readonly CategoryVote[]>
  findMapping(fingerprint: string): Promise<ExistingMapping | null>
  promoteMapping(fingerprint: string, categoryId: string, confirmedByUsers: number): Promise<void>
  findCategoryIdByName(name: string): Promise<string | null>
}

export type MerchantConsensusServiceDeps = {
  readonly repo: IConsensusRepository
  readonly logger: AppLogger
}

export type ConsensusOutcome =
  | { readonly promoted: true; readonly categoryId: string; readonly users: number }
  | { readonly promoted: false; readonly reason: string }

export class MerchantConsensusService {
  private readonly repo: IConsensusRepository
  private readonly logger: AppLogger
  private transfersId: string | null = null

  public constructor(deps: MerchantConsensusServiceDeps) {
    this.repo = deps.repo
    this.logger = deps.logger
  }

  /**
   * Called after a user corrects a merchant's category.
   *
   * Runs at the moment new evidence arrives rather than on a schedule, so the
   * shared map reflects reality as soon as it is established. It is one indexed
   * grouped query plus, rarely, one write.
   */
  public async evaluate(fingerprint: string): Promise<ConsensusOutcome> {
    const votes = await this.repo.tallyPreferences(fingerprint)
    if (votes.length === 0) {
      return { promoted: false, reason: 'no preferences recorded' }
    }

    const total = votes.reduce((sum, vote) => sum + vote.users, 0)
    const leader = votes.reduce((best, vote) => (vote.users > best.users ? vote : best))

    if (leader.users < CONSENSUS_THRESHOLD) {
      return { promoted: false, reason: `only ${leader.users} of ${CONSENSUS_THRESHOLD} users` }
    }

    // Strictly more than half, so an evenly split merchant is never promoted.
    if (leader.users * 2 <= total) {
      return { promoted: false, reason: `contested: ${leader.users} of ${total} users` }
    }

    if (this.transfersId === null) {
      this.transfersId = await this.repo.findCategoryIdByName('transfers')
    }
    if (leader.categoryId === this.transfersId) {
      return { promoted: false, reason: 'transfers are relationships, not merchants' }
    }

    const existing = await this.repo.findMapping(fingerprint)
    if (existing !== null) {
      if (existing.source === 'SEEDED') {
        // Logged rather than silently ignored: a crowd contradicting curated
        // data is a signal worth someone looking at.
        this.logger.warn(
          { fingerprint, seeded: existing.categoryId, crowd: leader.categoryId, users: leader.users },
          'Users disagree with a seeded merchant mapping; leaving the seed in place',
        )
        return { promoted: false, reason: 'seeded mappings are curated' }
      }
      if (existing.categoryId === leader.categoryId) {
        // Already correct. Still worth refreshing the count so the record
        // reflects how well established it is.
        await this.repo.promoteMapping(fingerprint, leader.categoryId, leader.users)
        return { promoted: false, reason: 'already mapped to this category' }
      }
    }

    await this.repo.promoteMapping(fingerprint, leader.categoryId, leader.users)
    this.logger.info(
      { fingerprint, categoryId: leader.categoryId, users: leader.users, replaced: existing?.source ?? null },
      'Promoted merchant mapping from user consensus',
    )
    return { promoted: true, categoryId: leader.categoryId, users: leader.users }
  }
}
