declare module 'opossum' {
  import { EventEmitter } from 'events'

  export interface CircuitBreakerOptions {
    readonly timeout?: number
    readonly errorThresholdPercentage?: number
    readonly resetTimeout?: number
    readonly [key: string]: any
  }

  export default class CircuitBreaker<TI extends readonly any[] = any[], TR = any> extends EventEmitter {
    public constructor(action: (...args: any[]) => Promise<TR>, options?: CircuitBreakerOptions)
    public fire(...args: TI): Promise<TR>
    public fallback(fallbackFunction: (...args: any[]) => any): this
    public readonly opened: boolean
  }
}
