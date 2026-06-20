import type { INotificationRepository } from '../repositories/notification.repo'
import type { IPushProvider } from '../providers/fcm.provider'
import type { IEmailProvider } from '../providers/postmark.provider'
import type { IUserRepository } from '../../auth/repositories/user.repo'
import type { ICategoryRepository } from '../../categories/repositories/category.repo'
import type { AppLogger } from '../../../core/logger'
import { notFound } from '../../../core/errors/factories'

export class NotificationService {
  private readonly notificationRepo: INotificationRepository
  private readonly pushProvider: IPushProvider
  private readonly emailProvider: IEmailProvider
  private readonly userRepo: IUserRepository
  private readonly categoryRepo: ICategoryRepository
  private readonly logger: AppLogger

  public constructor(deps: {
    readonly notificationRepo: INotificationRepository
    readonly pushProvider: IPushProvider
    readonly emailProvider: IEmailProvider
    readonly userRepo: IUserRepository
    readonly categoryRepo: ICategoryRepository
    readonly logger: AppLogger
  }) {
    this.notificationRepo = deps.notificationRepo
    this.pushProvider = deps.pushProvider
    this.emailProvider = deps.emailProvider
    this.userRepo = deps.userRepo
    this.categoryRepo = deps.categoryRepo
    this.logger = deps.logger
  }

  public async sendBudgetAlert(
    userId: string,
    budgetId: string,
    categoryId: string,
    spentKobo: bigint,
    limitKobo: bigint
  ): Promise<void> {
    const prefs = await this.notificationRepo.getPreferences(userId)
    if (!prefs.budgetAlerts) {
      this.logger.debug({ userId, budgetId }, 'Skipping budget alert: user has opted out')
      return
    }

    const category = await this.categoryRepo.findById(categoryId)
    const categoryName = category?.name ?? 'Unknown Category'

    const spentNaira = (Number(spentKobo) / 100).toFixed(2)
    const limitNaira = (Number(limitKobo) / 100).toFixed(2)
    const title = 'Budget Limit Breached'
    const body = `You spent ₦${spentNaira} of your ₦${limitNaira} budget in '${categoryName}'.`

    await this.dispatchPushToUser(userId, title, body, {
      type: 'budget_breached',
      budgetId,
    })
  }

  public async sendPaymentFailed(userId: string): Promise<void> {
    const prefs = await this.notificationRepo.getPreferences(userId)
    if (!prefs.paymentFailures) {
      this.logger.debug({ userId }, 'Skipping payment failed notification: user has opted out')
      return
    }

    const user = await this.userRepo.findById(userId)
    if (!user) {
      throw notFound('User not found')
    }

    const title = 'Payment Failed'
    const body = 'We were unable to charge your card. Your Pro subscription has entered a 7-day grace period.'

    // 1. Send push notifications
    await this.dispatchPushToUser(userId, title, body, { type: 'payment_failed' })

    // 2. Send email notification
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
        <h2 style="color: #d93025;">Pro Subscription Payment Failed</h2>
        <p>Dear FinTrack User,</p>
        <p>We were unable to process the renewal payment for your FinTrack Pro subscription.</p>
        <p><strong>What this means:</strong> Your account has entered a <strong>7-day grace period</strong>. You will retain all Pro features until the grace period ends. If payment is not received by then, your account will be downgraded to the Free tier.</p>
        <p>Please log in to your mobile app to update your card and billing details.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #888;">This is an automated security notification from FinTrack. Do not reply to this email.</p>
      </div>
    `
    await this.emailProvider.sendEmail({
      to: user.email,
      subject: 'FinTrack: Pro Subscription Payment Failed',
      htmlBody: emailHtml,
      textBody: `FinTrack: Your Pro subscription payment failed. Your account is in a 7-day grace period. Please log in to update your card details.`,
    })
  }

  public async sendCardExpiring(userId: string): Promise<void> {
    const prefs = await this.notificationRepo.getPreferences(userId)
    if (!prefs.subscriptionExpiring) {
      this.logger.debug({ userId }, 'Skipping card expiring notification: user has opted out')
      return
    }

    const user = await this.userRepo.findById(userId)
    if (!user) {
      throw notFound('User not found')
    }

    const title = 'Card Expiring Soon'
    const body = 'The card associated with your Pro subscription is expiring soon. Please update your billing details.'

    // 1. Send push
    await this.dispatchPushToUser(userId, title, body, { type: 'card_expiring' })

    // 2. Send email
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
        <h2 style="color: #e67e22;">Billing Card Expiring Soon</h2>
        <p>Dear FinTrack User,</p>
        <p>The card associated with your FinTrack Pro subscription is expiring soon.</p>
        <p>To prevent any disruption to your subscription features, please log in to the FinTrack mobile app and update your payment details.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #888;">This is an automated notification from FinTrack. Do not reply to this email.</p>
      </div>
    `
    await this.emailProvider.sendEmail({
      to: user.email,
      subject: 'FinTrack: Billing Card Expiring Soon',
      htmlBody: emailHtml,
      textBody: `FinTrack: The card associated with your Pro subscription is expiring soon. Please update your payment details in the app.`,
    })
  }

  public async sendSubscriptionExpired(userId: string): Promise<void> {
    const prefs = await this.notificationRepo.getPreferences(userId)
    if (!prefs.subscriptionExpiring) {
      this.logger.debug({ userId }, 'Skipping subscription expired notification: user has opted out')
      return
    }

    const user = await this.userRepo.findById(userId)
    if (!user) {
      throw notFound('User not found')
    }

    const title = 'Subscription Expired'
    const body = 'Your Pro subscription has expired and your account has been downgraded to the Free tier.'

    // 1. Send push
    await this.dispatchPushToUser(userId, title, body, { type: 'subscription_expired' })

    // 2. Send email
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
        <h2>Pro Subscription Expired</h2>
        <p>Dear FinTrack User,</p>
        <p>Your FinTrack Pro subscription grace period has expired, and your account has been downgraded to the Free tier.</p>
        <p><strong>What this means:</strong> You will no longer have access to premium features (including automated email parser syncing, custom reports, and advanced budgets). However, all your transaction logs and existing data are safe.</p>
        <p>You can resubscribe at any time inside the app to regain Pro benefits.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #888;">This is an automated notification from FinTrack. Do not reply to this email.</p>
      </div>
    `
    await this.emailProvider.sendEmail({
      to: user.email,
      subject: 'FinTrack: Pro Subscription Expired',
      htmlBody: emailHtml,
      textBody: `FinTrack: Your Pro subscription has expired and your account has been downgraded to the Free tier. You can resubscribe inside the app.`,
    })
  }

  public async sendDataDeletionConfirmation(userId: string, email: string): Promise<void> {
    // NDPR Deletion Confirmation is a critical regulatory notification. No opt-out allowed.
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
        <h2 style="color: #d93025;">FinTrack Data Deletion Processed</h2>
        <p>Hello,</p>
        <p>As requested, all personal and financial data associated with your FinTrack account has been permanently deleted from our primary servers under NDPR compliance guidelines.</p>
        <p>Any associated Google/Gmail API OAuth authorization scopes have been revoked. Operational audit logs and payment history events have been stripped of personally identifiable references and anonymized.</p>
        <p>Thank you for using FinTrack. If you wish to use the service again, you will need to register a new account.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #888;">This is an automated NDPR compliance confirmation from FinTrack. Do not reply to this email.</p>
      </div>
    `

    await this.emailProvider.sendEmail({
      to: email,
      subject: 'FinTrack: Data Deletion Confirmed (NDPR)',
      htmlBody: emailHtml,
      textBody: `FinTrack: Your request for data deletion has been processed successfully. All personal records have been purged.`,
    })
  }

  public async sendDataExportReady(
    userId: string,
    email: string,
    downloadUrl: string,
    expiresAt: string
  ): Promise<void> {
    // Data export notification is a regulatory right — no opt-out.
    const formattedExpiry = new Date(expiresAt).toLocaleString('en-NG', {
      dateStyle: 'long',
      timeStyle: 'short',
    })

    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
        <h2 style="color: #1a73e8;">Your FinTrack Data Export is Ready</h2>
        <p>Hello,</p>
        <p>Your data export has been generated and is ready for download. This file contains all your FinTrack data including transactions, budgets, reports, and account metadata in JSON format.</p>
        <p><strong>Important:</strong> This download link will expire on <strong>${formattedExpiry}</strong> (48 hours from generation). Please download your data before then.</p>
        <p style="margin: 20px 0;">
          <a href="${downloadUrl}" style="background-color: #1a73e8; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Download Your Data</a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #888;">This is an automated NDPR compliance notification from FinTrack. Do not reply to this email.</p>
      </div>
    `

    await this.emailProvider.sendEmail({
      to: email,
      subject: 'FinTrack: Your Data Export is Ready',
      htmlBody: emailHtml,
      textBody: `FinTrack: Your data export is ready for download. Visit ${downloadUrl} to download your data. This link expires on ${formattedExpiry}.`,
    })
  }

  private async dispatchPushToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>
  ): Promise<void> {
    const tokens = await this.notificationRepo.getTokensByUserId(userId)
    if (tokens.length === 0) {
      this.logger.debug({ userId }, 'No active device tokens found for user push dispatch')
      return
    }

    // Deliver push to all active devices in parallel
    const promises = tokens.map((t) =>
      this.pushProvider.sendPush({
        token: t.token,
        title,
        body,
        data,
      }).catch((err) => {
        // Log individual token delivery failures but do not block other tokens (Law 274: no broad failure cascade)
        this.logger.warn({ err, token: t.token, userId }, 'Failed to deliver push to specific device token')
      })
    )

    await Promise.all(promises)
  }
}
