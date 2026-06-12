import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type GuardrailViolation = {
  readonly file: string
  readonly rule: string
  readonly detail: string
}

const scannedExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const ignoredSegments = new Set(['node_modules', 'dist', 'coverage', '.git', 'generated'])
const moneyFields = [
  'amountKobo',
  'balanceKobo',
  'limitKobo',
  'spentKobo',
  'incomeKobo',
  'netKobo',
  'remainingKobo',
  'totalKobo',
] as const

function hasScannedExtension(path: string): boolean {
  return [...scannedExtensions].some((extension) => path.endsWith(extension))
}

function shouldIgnore(path: string): boolean {
  return path.split(sep).some((segment) => ignoredSegments.has(segment))
}

function collectFiles(root: string): readonly string[] {
  const entries = readdirSync(root)
  const files: string[] = []

  for (const entry of entries) {
    const path = join(root, entry)
    if (shouldIgnore(path)) {
      continue
    }

    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...collectFiles(path))
      continue
    }

    if (stat.isFile() && hasScannedExtension(path)) {
      files.push(path)
    }
  }

  return files
}

function checkFile(root: string, file: string): readonly GuardrailViolation[] {
  const relativePath = relative(root, file)
  const normalized = relativePath.replaceAll('\\', '/')
  const source = readFileSync(file, 'utf8')
  const violations: GuardrailViolation[] = []

  if (/\.\$transaction\s*\(\s*async\b/.test(source)) {
    violations.push({
      file: normalized,
      rule: 'no-interactive-prisma-transactions',
      detail: 'Use Prisma array transactions, not prisma.$transaction(async ...).',
    })
  }

  if (/\bas\s+any\b/.test(source)) {
    violations.push({
      file: normalized,
      rule: 'no-as-any',
      detail: 'Use unknown and narrow it explicitly instead of as any.',
    })
  }

  if (/\bconsole\./.test(source)) {
    violations.push({
      file: normalized,
      rule: 'no-console',
      detail: 'Production code must use Pino structured logging.',
    })
  }

  const isRouteOrUseCase = normalized.includes('/routes/') || normalized.includes('/use-cases/')
  if (isRouteOrUseCase && (source.includes('@prisma/client') || source.includes('generated/prisma'))) {
    violations.push({
      file: normalized,
      rule: 'no-prisma-in-routes-or-use-cases',
      detail: 'Routes call use cases; use cases depend on repository interfaces only.',
    })
  }

  for (const field of moneyFields) {
    const numberPattern = new RegExp(`\\b${field}\\??\\s*:\\s*number\\b`)
    if (numberPattern.test(source)) {
      violations.push({
        file: normalized,
        rule: 'no-number-money',
        detail: `${field} must be bigint internally or a string at JSON boundaries.`,
      })
    }
  }

  const isModuleRoute = normalized.startsWith('src/modules/') && normalized.includes('/routes/')
  if (isModuleRoute && !/UseCase\b/.test(source)) {
    violations.push({
      file: normalized,
      rule: 'route-must-call-use-case',
      detail: 'Feature routes must be thin adapters that call use cases.',
    })
  }

  return violations
}

export function runGuardrails(root = process.cwd()): readonly GuardrailViolation[] {
  const files = collectFiles(join(root, 'src'))
  return files.flatMap((file) => checkFile(root, file))
}

if (require.main === module) {
  const violations = runGuardrails()
  if (violations.length > 0) {
    process.stderr.write('Architecture guardrail violations:\n')
    for (const violation of violations) {
      process.stderr.write(`- ${violation.file}: ${violation.rule}: ${violation.detail}\n`)
    }
    process.exit(1)
  }

  process.stdout.write('Architecture guardrails passed.\n')
}
