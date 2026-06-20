import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { AppLogger } from '../logger'

// ──────────────────────────────────────────────────────────────────
// Storage provider interface — swap LocalStorageProvider for R2/S3
// in production via the module DI wiring.
// ──────────────────────────────────────────────────────────────────

export type UploadResult = {
  readonly key: string
  readonly downloadUrl: string
  readonly expiresAt: Date
}

export interface IStorageProvider {
  upload(key: string, data: Buffer, contentType: string): Promise<UploadResult>
}

// ──────────────────────────────────────────────────────────────────
// Local filesystem mock — writes to disk and returns a local URL.
// Swap for S3/R2 via environment config when deploying to production.
// ──────────────────────────────────────────────────────────────────

export class LocalStorageProvider implements IStorageProvider {
  private readonly basePath: string
  private readonly logger: AppLogger
  private readonly expiryMs: number

  public constructor(logger: AppLogger, basePath?: string | undefined, expiryMs?: number | undefined) {
    // Default to ./data/exports relative to cwd
    this.basePath = basePath ?? join(process.cwd(), 'data', 'exports')
    this.logger = logger
    // Default 48 hours
    this.expiryMs = expiryMs ?? 48 * 60 * 60 * 1_000
  }

  public async upload(key: string, data: Buffer, _contentType: string): Promise<UploadResult> {
    const filePath = join(this.basePath, key)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, data)

    const expiresAt = new Date(Date.now() + this.expiryMs)

    this.logger.info(
      { key, sizeBytes: data.byteLength, expiresAt: expiresAt.toISOString() },
      'File written to local storage'
    )

    // In local dev, the "download URL" is just a file path reference.
    // In production, this would be a presigned URL from R2/S3.
    const downloadUrl = `file://${filePath}`

    return {
      key,
      downloadUrl,
      expiresAt,
    }
  }
}
