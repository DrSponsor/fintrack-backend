import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runGuardrails } from '../scripts/architecture-guardrails'

describe('architecture guardrails', () => {
  it('passes for the current repository state', () => {
    expect(runGuardrails(process.cwd())).toEqual([])
  })

  it('detects forbidden patterns in feature code', () => {
    const root = join(tmpdir(), `fintrack-guardrails-${Date.now()}`)
    const routeDir = join(root, 'src', 'modules', 'transactions', 'routes')
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(join(routeDir, 'bad.route.ts'), [
      "import { PrismaClient } from '@prisma/client'",
      'const prisma = new PrismaClient()',
      'type Bad = { amountKobo: number }',
      'async function handler(): Promise<void> {',
      '  console.log("bad")',
      '  await prisma.$transaction(async () => {})',
      '}',
      'export { handler }',
    ].join('\n'))

    const violations = runGuardrails(root)
    expect(violations.map((violation) => violation.rule)).toEqual(expect.arrayContaining([
      'no-prisma-in-routes-or-use-cases',
      'no-number-money',
      'no-console',
      'no-interactive-prisma-transactions',
      'route-must-call-use-case',
    ]))
  })
})
