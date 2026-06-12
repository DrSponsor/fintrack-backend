import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const baseEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/fintrack?pgbouncer=true',
  DIRECT_URL: 'postgresql://postgres:postgres@localhost:5432/fintrack',
  REDIS_URL: 'redis://localhost:6379',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64'),
}

describe('loadConfig', () => {
  it('requires PgBouncer mode on DATABASE_URL', () => {
    expect(() => loadConfig({
      ...baseEnv,
      DATABASE_URL: 'postgresql://fintrack:fintrack@localhost:5432/fintrack',
    })).toThrow(/pgbouncer=true/)
  })

  it('requires a 32-byte field encryption key', () => {
    expect(() => loadConfig({
      ...baseEnv,
      FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(31).toString('base64'),
    })).toThrow(/32 bytes/)
  })

  it('falls back read replica URL to the PgBouncer URL in local development', () => {
    const config = loadConfig(baseEnv)
    expect(config.readReplicaDatabaseUrl).toBe(baseEnv.DATABASE_URL)
  })
})
