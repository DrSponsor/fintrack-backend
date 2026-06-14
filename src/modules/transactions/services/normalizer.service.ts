export class NormalizerService {
  /**
   * Title-cases merchant name, trims excess whitespaces.
   */
  public normalizeMerchantName(rawName: string): string {
    const cleaned = rawName.replace(/\s+/g, ' ').trim()
    if (cleaned.length === 0) {
      return 'Unknown Merchant'
    }

    return cleaned
      .toLowerCase()
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  /**
   * Generates a unique, lowercase alphanumeric fingerprint from a normalized merchant name.
   */
  public getMerchantFingerprint(normalizedName: string): string {
    return normalizedName.toLowerCase().replace(/[^a-z0-9]/g, '')
  }
}
