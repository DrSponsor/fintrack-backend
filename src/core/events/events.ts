import { z } from 'zod'

export const transactionCreatedPayloadSchema = z.object({
  transactionId: z.string().uuid(),
  userId: z.string().uuid(),
  amountKobo: z.string().regex(/^-?\d+$/),
  categoryId: z.string().uuid(),
})

export type TransactionCreatedPayload = z.infer<typeof transactionCreatedPayloadSchema>

export type EventPayloadMap = {
  readonly 'transaction.created': TransactionCreatedPayload
}

export type AppEventName = keyof EventPayloadMap

const eventNames: readonly AppEventName[] = ['transaction.created']

export function isAppEventName(value: string): value is AppEventName {
  return eventNames.includes(value as AppEventName)
}

export function parseEventPayload<TEvent extends AppEventName>(
  event: TEvent,
  payload: unknown,
): EventPayloadMap[TEvent] {
  // TypeScript cannot narrow generic type parameters through switch statements.
  // Each case returns the correct concrete type; the assertion bridges the generic.
  switch (event) {
    case 'transaction.created':
      return transactionCreatedPayloadSchema.parse(payload) as EventPayloadMap[TEvent]
    default: {
      // Exhaustive check: adding a new event name without a case here produces a compile error.
      const _exhaustive: never = event as never
      throw new Error(`Unhandled event type: ${String(_exhaustive)}`)
    }
  }
}
