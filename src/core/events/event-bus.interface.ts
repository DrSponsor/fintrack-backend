import type { EventPayloadMap } from './events'

export interface IEventBus {
  publish<TEvent extends keyof EventPayloadMap>(
    event: TEvent,
    payload: EventPayloadMap[TEvent],
  ): Promise<void>

  subscribe<TEvent extends keyof EventPayloadMap>(
    event: TEvent,
    handler: (payload: EventPayloadMap[TEvent]) => Promise<void>,
  ): void
}
