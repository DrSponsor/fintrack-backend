import type { FastifyReply, FastifyRequest } from 'fastify'
import { subscriptionRequired, unauthenticated } from '../errors/factories'

/**
 * Tier enforcement middleware.
 *
 * Checks whether the authenticated user has an active Pro subscription.
 * Handles the edge case where the JWT's `tier` claim is stale due to
 * a recent subscription change (e.g., user just upgraded or was downgraded
 * by the grace period worker).
 *
 * Flow:
 *   1. JWT says PRO and no tier-change signal in Redis → allow.
 *   2. JWT says FREE → check Redis for `tier-change:{userId}` signal.
 *      If signal exists, fall through to DB check.
 *   3. JWT says PRO but subscription has expired (`subscriptionExpiresAt < now`)
 *      → fall through to DB check.
 *   4. DB check: query subscription status. If ACTIVE → allow.
 *      Otherwise → 402.
 *
 * The Redis `tier-change:{userId}` key is set by the billing webhook
 * processor when a subscription state changes. It has a 1-hour TTL.
 * This avoids checking the database on every single Pro endpoint call.
 *
 * IMPORTANT: Do NOT fire-and-forget a JWT refresh from here.
 * preHandlers run before reply.send(). An async function setting headers
 * or cookies after the response is sent causes a Fastify silent failure.
 * The Redis key handles this correctly — the next auth flow issues a
 * fresh JWT with the updated tier.
 */
export async function requireSubscription(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (request.user === undefined) {
    throw unauthenticated()
  }

  const { tier, sub: userId, subscriptionExpiresAt } = request.user

  // Fast path: user is PRO, no tier-change pending, subscription not expired.
  if (tier === 'PRO') {
    const tierChangePending = await request.server.redis.exists(`tier-change:${userId}`)

    if (!tierChangePending) {
      // No tier-change signal. Check if subscription has expired per JWT claims.
      if (subscriptionExpiresAt !== undefined) {
        const expiresAt = new Date(subscriptionExpiresAt)
        if (expiresAt > new Date()) {
          // JWT is fresh and subscription is valid. Allow.
          return
        }
        // Subscription expiry in JWT has passed → fall through to DB check.
      } else {
        // JWT says PRO but has no expiry claim → allow (backwards compat).
        return
      }
    }
    // Tier-change signal exists or subscription expired → fall through to DB check.
  }

  // Slow path: verify against the database.
  // This only runs when the JWT is stale or a tier change just happened.
  const subscription = await request.server.db.primary.subscription.findUnique({
    where: { userId },
    select: { status: true },
  })

  if (subscription?.status !== 'ACTIVE') {
    throw subscriptionRequired()
  }

  // Subscription is ACTIVE in DB. Allow the request.
  // The user's next token refresh will pick up the correct tier.
}
