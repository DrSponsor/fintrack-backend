declare module 'opossum' {
  import { EventEmitter } from 'events'

  export interface CircuitBreakerOptions {
    readonly timeout?: number
    readonly errorThresholdPercentage?: number
    readonly resetTimeout?: number
    readonly [key: string]: unknown
  }

  export default class CircuitBreaker<TI extends readonly unknown[] = unknown[], TR = unknown> extends EventEmitter {
    public constructor(action: (...args: TI) => Promise<TR>, options?: CircuitBreakerOptions)
    public fire(...args: TI): Promise<TR>
    // opossum invokes the fallback as `fn(...originalArgs, err)` — the same
    // arguments `.fire()` was called with, plus the triggering error appended
    // last (see node_modules/opossum/lib/circuit.js's `fallback()` helper).
    public fallback(fallbackFunction: (...args: [...TI, Error]) => TR | Promise<TR>): this
    public readonly opened: boolean
  }
}
