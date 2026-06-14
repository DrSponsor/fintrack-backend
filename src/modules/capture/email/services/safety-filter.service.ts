export class SafetyFilterService {
  private readonly securityKeywords = [
    'otp',
    'verification',
    'security',
    'password',
    'login',
    'two-factor',
    '2fa',
    'code',
    'reset',
    'passcode',
    'mfa',
  ] as const

  private readonly transactionKeywords = [
    'transaction',
    'alert',
    'debit',
    'credit',
    'payment',
    'transfer',
    'receipt',
    'spent',
    'received',
    'amount',
    'purchase',
    'charge',
    'successful',
    'declined',
    'failed',
    'reversed',
  ] as const

  /**
   * Returns true if the email subject or body indicates a sensitive security email
   * (e.g. OTP, login notification, password reset) that should be discarded.
   */
  public shouldDiscard(subject: string, bodyText = ''): boolean {
    const combined = `${subject} ${bodyText}`.toLowerCase()

    for (const word of this.securityKeywords) {
      if (combined.includes(word)) {
        return true
      }
    }

    return false
  }

  /**
   * Returns true if the email likely contains financial transaction data.
   */
  public hasTransactionKeywords(subject: string, bodyText = ''): boolean {
    const combined = `${subject} ${bodyText}`.toLowerCase()
    for (const word of this.transactionKeywords) {
      if (combined.includes(word)) {
        return true
      }
    }
    return false
  }
}
