/**
 * Builds a BullMQ-safe custom job id.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * BullMQ uses ':' as its Redis key separator, so it REJECTS custom job ids
 * containing one — `Job.validateOptions` throws `Custom Id cannot contain :`
 * at the moment the job is added.
 *
 * Thirteen call sites across analysis, billing, budgets and email capture had
 * independently reached for `:` as a natural-looking separator, which meant
 * every one of them threw the first time it ran. The failure is invisible until
 * that exact code path executes, which is why it survived: queueing a job is
 * usually the last statement in a use case, so everything before it succeeds
 * and only the response fails. Connecting a Gmail account, for instance,
 * exchanged the OAuth tokens and registered the Gmail watch successfully — and
 * then returned a 500.
 *
 * ── Why a helper rather than fixing each string ──────────────────────────
 * Fixing the literals would have fixed today's bug and left the trap armed for
 * the next person, because ':' is genuinely the obvious choice — it is what
 * Redis itself uses, and what BullMQ uses internally. A named function is the
 * place to record that the obvious choice is the wrong one.
 *
 * ── Note on dedup ────────────────────────────────────────────────────────
 * Several of these ids exist to DEDUPLICATE: BullMQ drops an add whose job id
 * already exists. Any call sites that must collide with each other therefore
 * have to build their ids identically. `weekly` and `monthly` report ids are
 * each constructed in three separate files for this reason, and all three must
 * keep passing the same parts in the same order.
 */

/** Characters BullMQ forbids in a custom job id. */
const ILLEGAL = /:/g

/**
 * Joins parts into a job id with '-', replacing any illegal character.
 *
 * Parts are sanitised individually rather than only at the end, because some
 * come from outside the system — a payment provider's event id, a Gmail
 * message id — and an external identifier containing ':' would otherwise fail
 * a webhook at runtime with an error that points at BullMQ rather than at the
 * data that caused it.
 */
export function jobId(...parts: readonly (string | number)[]): string {
  return parts.map((part) => String(part).replace(ILLEGAL, '-')).join('-')
}
