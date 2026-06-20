import type { PrismaClient } from '../../../generated/prisma/client'

export interface DeviceTokenRecord {
  readonly id: string
  readonly userId: string
  readonly token: string
  readonly platform: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface NotificationPreferenceRecord {
  readonly id: string
  readonly userId: string
  readonly budgetAlerts: boolean
  readonly paymentFailures: boolean
  readonly subscriptionExpiring: boolean
  readonly weeklyReports: boolean
  readonly monthlyReports: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface INotificationRepository {
  registerToken(userId: string, token: string, platform: 'ANDROID' | 'IOS'): Promise<DeviceTokenRecord>
  unregisterToken(userId: string, token: string): Promise<void>
  getTokensByUserId(userId: string): Promise<readonly DeviceTokenRecord[]>
  
  getPreferences(userId: string): Promise<NotificationPreferenceRecord>
  updatePreferences(
    userId: string,
    preferences: {
      readonly budgetAlerts?: boolean | undefined
      readonly paymentFailures?: boolean | undefined
      readonly subscriptionExpiring?: boolean | undefined
      readonly weeklyReports?: boolean | undefined
      readonly monthlyReports?: boolean | undefined
    }
  ): Promise<NotificationPreferenceRecord>
}

export class PrismaNotificationRepository implements INotificationRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async registerToken(userId: string, token: string, platform: 'ANDROID' | 'IOS'): Promise<DeviceTokenRecord> {
    try {
      return await this.prisma.deviceToken.create({
        data: {
          userId,
          token,
          platform,
        },
      })
    } catch (err: any) {
      // P2002 is Prisma's unique constraint violation code
      if (err.code === 'P2002') {
        // Re-assign the device token to the current user
        return await this.prisma.deviceToken.update({
          where: { token },
          data: { userId, platform },
        })
      }
      throw err
    }
  }

  public async unregisterToken(userId: string, token: string): Promise<void> {
    // Delete only if it belongs to the current user (security boundary check)
    await this.prisma.deviceToken.deleteMany({
      where: {
        userId,
        token,
      },
    })
  }

  public async getTokensByUserId(userId: string): Promise<readonly DeviceTokenRecord[]> {
    return await this.prisma.deviceToken.findMany({
      where: { userId },
    })
  }

  public async getPreferences(userId: string): Promise<NotificationPreferenceRecord> {
    const pref = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    })

    if (pref) {
      return pref
    }

    // Default preference initialization on first read (TOCTOU safe upsert)
    try {
      return await this.prisma.notificationPreference.create({
        data: {
          userId,
          budgetAlerts: true,
          paymentFailures: true,
          subscriptionExpiring: true,
          weeklyReports: true,
          monthlyReports: true,
        },
      })
    } catch (err: any) {
      if (err.code === 'P2002') {
        const existing = await this.prisma.notificationPreference.findUnique({
          where: { userId },
        })
        if (existing) {
          return existing
        }
      }
      throw err
    }
  }

  public async updatePreferences(
    userId: string,
    preferences: {
      readonly budgetAlerts?: boolean | undefined
      readonly paymentFailures?: boolean | undefined
      readonly subscriptionExpiring?: boolean | undefined
      readonly weeklyReports?: boolean | undefined
      readonly monthlyReports?: boolean | undefined
    }
  ): Promise<NotificationPreferenceRecord> {
    // Ensure preferences are initialized first, then update them
    await this.getPreferences(userId)

    const updateData: {
      budgetAlerts?: boolean
      paymentFailures?: boolean
      subscriptionExpiring?: boolean
      weeklyReports?: boolean
      monthlyReports?: boolean
    } = {}

    if (preferences.budgetAlerts !== undefined) {
      updateData.budgetAlerts = preferences.budgetAlerts
    }
    if (preferences.paymentFailures !== undefined) {
      updateData.paymentFailures = preferences.paymentFailures
    }
    if (preferences.subscriptionExpiring !== undefined) {
      updateData.subscriptionExpiring = preferences.subscriptionExpiring
    }
    if (preferences.weeklyReports !== undefined) {
      updateData.weeklyReports = preferences.weeklyReports
    }
    if (preferences.monthlyReports !== undefined) {
      updateData.monthlyReports = preferences.monthlyReports
    }

    return await this.prisma.notificationPreference.update({
      where: { userId },
      data: updateData,
    })
  }
}
