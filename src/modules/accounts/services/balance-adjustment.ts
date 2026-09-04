/**
 * What has happened to an account since its bank last stated a balance.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 * `Account.balanceKobo` is only ever written alongside `lastTransactionDate`,
 * and only by a transaction carrying the bank's own `balanceAfterKobo` — see
 * PrismaTransactionRepository.create. A typed entry carries no such figure, so
 * recording one moved nothing: the user added a ₦5,000 payment and the
 * dashboard went on showing the same balance as before, which is the app
 * disagreeing with the person using it about money they just spent.
 *
 * ── Why the anchor makes this simple ─────────────────────────────────────
 * Because those two columns are written together, `lastTransactionDate` is not
 * merely the newest transaction — it is the moment the stated balance was
 * true. That turns a fiddly reconciliation into one rule:
 *
 *     displayed = stated + (everything dated after the anchor)
 *
 * and every case falls out of it rather than needing its own branch.
 *
 *   A typed entry after the anchor       adjusts the balance, which is the fix.
 *   A typed entry BEFORE the anchor      is ignored, because the bank's later
 *                                        statement already accounts for it.
 *                                        Without this the figure would be
 *                                        wrong by that amount forever, and
 *                                        nothing would ever correct it.
 *   A new alert carrying a balance       becomes the anchor, so every
 *                                        adjustment it supersedes drops out on
 *                                        its own.
 *   An alert carrying NO balance         adjusts, exactly like a typed entry —
 *                                        it is a real movement the bank has
 *                                        not restated a figure for.
 *
 * ── Why it is returned separately from the balance ───────────────────────
 * The stated figure and the adjustment are different KINDS of claim: one is
 * what a bank said, the other is what this app worked out. Adding them in the
 * repository would leave the screen unable to tell a person which is which,
 * and "₦195,000" with no way to see it is "₦200,000 less the ₦5,000 you added"
 * is the sort of unexplained number that makes people stop trusting a ledger.
 */

export type BalanceMovement = {
  readonly type: 'DEBIT' | 'CREDIT'
  readonly amountKobo: bigint
}

/**
 * Net effect of movements on a balance, in kobo. Credits add, debits subtract.
 *
 * Callers pass only movements dated after the anchor; deciding what is in
 * scope belongs to the query, not here.
 */
export function netAdjustmentKobo(movements: readonly BalanceMovement[]): bigint {
  let net = 0n
  for (const movement of movements) {
    net += movement.type === 'CREDIT' ? movement.amountKobo : -movement.amountKobo
  }
  return net
}
