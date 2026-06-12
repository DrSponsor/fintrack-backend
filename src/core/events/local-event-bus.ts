import type { IEventBus } from './event-bus.interface'
import type { EventPayloadMap } from './events'

type AnyEventPayload = EventPayloadMap[keyof EventPayloadMap]
type AnyEventHandler = (payload: AnyEventPayload) => Promise<void>

export class LocalEventBus implements IEventBus {
  private readonly handlers = new Map<keyof EventPayloadMap, Set<AnyEventHandler>>()

  public async publish<TEvent extends keyof EventPayloadMap>(
    event: TEvent,
    payload: EventPayloadMap[TEvent],
  ): Promise<void> {
    const handlers = this.handlers.get(event) ?? new Set<AnyEventHandler>()
    await Promise.all([...handlers].map((handler) => handler(payload)))
  }

  public subscribe<TEvent extends keyof EventPayloadMap>(
    event: TEvent,
    handler: (payload: EventPayloadMap[TEvent]) => Promise<void>,
  ): void {
    const handlers = this.handlers.get(event) ?? new Set<AnyEventHandler>()
    handlers.add(handler)
    this.handlers.set(event, handlers)
  }
}
