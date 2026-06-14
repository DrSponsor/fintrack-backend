export class SafetyFilterService {
  private readonly discardKeywords = [
    'otp',
    'one-time password',
    'one time password',
    'verification code',
    'reset your password',
    'password reset',
    'login alert',
    'new login',
    'sign-in alert',
    'security alert',
    'two-factor authentication',
    '2fa',
    'mfa',
  ]

  private readonly transactionKeywords = [
    'debit',
    'credit',
    'payment',
    'alert',
    'received',
    'transaction',
    'transfer',
    'amount',
    'val',
    'bal',
    '₦',
    'ngn',
    'receipt',
    'spent',
    'purchase',
    'charge',
    'successful',
    'declined',
    'failed',
    'reversed',
  ]

  /**
   * Returns true if the email subject or body indicates a sensitive security email
   * (e.g. OTP, login notification, password reset) that should be discarded.
   */
  public shouldDiscard(subject: string, bodyText = ''): boolean {
    const combined = `${subject} ${bodyText}`.toLowerCase()
    return this.discardKeywords.some((keyword) => combined.includes(keyword))
  }

  /**
   * Returns true if the email likely contains financial transaction data.
   */
  public hasTransactionKeywords(subject: string, bodyText = ''): boolean {
    const combined = `${subject} ${bodyText}`.toLowerCase()
    return this.transactionKeywords.some((keyword) => combined.includes(keyword))
  }
}
