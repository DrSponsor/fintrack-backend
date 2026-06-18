import type { PrismaClient } from '../../../generated/prisma/client'
import type { BillingProvider, SubscriptionStatus } from '../../../generated/prisma/client'

// ──────────────────────────────────────────────────────────────────
// Domain Types
// ──────────────────────────────────────────────────────────────────

export type BillingEventRecord = {
  readonly id: string
  readonly provider: BillingProvider
  readonly providerEventId: string
  readonly eventType: string
  readonly normalizedType: string
  readonly userId: string | null
  readonly payload: any
  readonly processed: boolean
  readonly processedAt: Date | null
  readonly processingError: string | null
  readonly createdAt: Date
}

export type SubscriptionRecord = {
  readonly id: string
  readonly userId: string
  readonly provider: BillingProvider
  readonly providerCustomerId: string
  readonly providerSubscriptionId: string
  readonly providerPlanId: string
  readonly status: SubscriptionStatus
  readonly currentPeriodStart: Date
  readonly currentPeriodEnd: Date
  readonly cancelledAt: Date | null
  readonly gracePeriodEndsAt: Date | null
  readonly trialEndsAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

// ──────────────────────────────────────────────────────────────────
// Repository Interfaces
// ──────────────────────────────────────────────────────────────────

export interface IBillingRepository {
  create(data: {
    readonly provider: BillingProvider
    readonly providerEventId: string
    readonly eventType: string
    readonly normalizedType: string
    readonly userId: string | null
    readonly payload: any
  }): Promise<BillingEventRecord>

  markProcessed(providerEventId: string): Promise<void>
  markFailed(providerEventId: string, error: string): Promise<void>
  markUnresolvable(providerEventId: string): Promise<void>
  getPayload(providerEventId: string): Promise<any>
}

export interface ISubscriptionRepository {
  findByUserId(userId: string): Promise<SubscriptionRecord | null>
  findBySubscriptionId(providerSubscriptionId: string): Promise<SubscriptionRecord | null>
  upsert(data: {
    readonly userId: string
    readonly provider: BillingProvider
    readonly providerCustomerId: string
    readonly providerSubscriptionId: string
    readonly providerPlanId: string
    readonly status: SubscriptionStatus
    readonly currentPeriodStart: Date
    readonly currentPeriodEnd: Date
    readonly trialEndsAt?: Date | null
  }): Promise<SubscriptionRecord>

  updateStatus(
    id: string,
    status: SubscriptionStatus,
    extra?: {
      readonly currentPeriodEnd?: Date
      readonly cancelledAt?: Date | null
      readonly gracePeriodEndsAt?: Date | null
    }
  ): Promise<SubscriptionRecord>

  findActiveSubscriptions(): Promise<readonly SubscriptionRecord[]>
  findGracePeriodSubscriptions(): Promise<readonly SubscriptionRecord[]>
}

// ──────────────────────────────────────────────────────────────────
// Prisma Implementations
// ──────────────────────────────────────────────────────────────────

export class PrismaBillingRepository implements IBillingRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async create(data: {
    readonly provider: BillingProvider
    readonly providerEventId: string
    readonly eventType: string
    readonly normalizedType: string
    readonly userId: string | null
    readonly payload: any
  }): Promise<BillingEventRecord> {
    const event = await this.prisma.billingEvent.create({
      data: {
        provider: data.provider,
        providerEventId: data.providerEventId,
        eventType: data.eventType,
        normalizedType: data.normalizedType,
        userId: data.userId,
        payload: data.payload,
      },
    })

    return {
      id: event.id,
      provider: event.provider,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      normalizedType: event.normalizedType,
      userId: event.userId,
      payload: event.payload,
      processed: event.processed,
      processedAt: event.processedAt,
      processingError: event.processingError,
      createdAt: event.createdAt,
    }
  }

  public async markProcessed(providerEventId: string): Promise<void> {
    await this.prisma.billingEvent.update({
      where: { providerEventId },
      data: {
        processed: true,
        processedAt: new Date(),
        processingError: null,
      },
    })
  }

  public async markFailed(providerEventId: string, error: string): Promise<void> {
    await this.prisma.billingEvent.update({
      where: { providerEventId },
      data: {
        processed: false,
        processingError: error,
      },
    })
  }

  public async markUnresolvable(providerEventId: string): Promise<void> {
    await this.prisma.billingEvent.update({
      where: { providerEventId },
      data: {
        processed: true,
        processedAt: new Date(),
        processingError: 'Unresolvable: userId is null',
      },
    })
  }

  public async getPayload(providerEventId: string): Promise<any> {
    const event = await this.prisma.billingEvent.findUnique({
      where: { providerEventId },
      select: { payload: true },
    })
    return event?.payload
  }
}

export class PrismaSubscriptionRepository implements ISubscriptionRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async findByUserId(userId: string): Promise<SubscriptionRecord | null> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    })

    if (!sub) return null

    return {
      id: sub.id,
      userId: sub.userId,
      provider: sub.provider,
      providerCustomerId: sub.providerCustomerId,
      providerSubscriptionId: sub.providerSubscriptionId,
      providerPlanId: sub.providerPlanId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelledAt: sub.cancelledAt,
      gracePeriodEndsAt: sub.gracePeriodEndsAt,
      trialEndsAt: sub.trialEndsAt,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    }
  }

  public async findBySubscriptionId(providerSubscriptionId: string): Promise<SubscriptionRecord | null> {
    const sub = await this.prisma.subscription.findUnique({
      where: { providerSubscriptionId },
    })

    if (!sub) return null

    return {
      id: sub.id,
      userId: sub.userId,
      provider: sub.provider,
      providerCustomerId: sub.providerCustomerId,
      providerSubscriptionId: sub.providerSubscriptionId,
      providerPlanId: sub.providerPlanId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelledAt: sub.cancelledAt,
      gracePeriodEndsAt: sub.gracePeriodEndsAt,
      trialEndsAt: sub.trialEndsAt,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    }
  }

  public async upsert(data: {
    readonly userId: string
    readonly provider: BillingProvider
    readonly providerCustomerId: string
    readonly providerSubscriptionId: string
    readonly providerPlanId: string
    readonly status: SubscriptionStatus
    readonly currentPeriodStart: Date
    readonly currentPeriodEnd: Date
    readonly trialEndsAt?: Date | null
  }): Promise<SubscriptionRecord> {
    const sub = await this.prisma.subscription.upsert({
      where: { userId: data.userId },
      create: {
        userId: data.userId,
        provider: data.provider,
        providerCustomerId: data.providerCustomerId,
        providerSubscriptionId: data.providerSubscriptionId,
        providerPlanId: data.providerPlanId,
        status: data.status,
        currentPeriodStart: data.currentPeriodStart,
        currentPeriodEnd: data.currentPeriodEnd,
        trialEndsAt: data.trialEndsAt ?? null,
      },
      update: {
        provider: data.provider,
        providerCustomerId: data.providerCustomerId,
        providerSubscriptionId: data.providerSubscriptionId,
        providerPlanId: data.providerPlanId,
        status: data.status,
        currentPeriodStart: data.currentPeriodStart,
        currentPeriodEnd: data.currentPeriodEnd,
        trialEndsAt: data.trialEndsAt ?? null,
        gracePeriodEndsAt: null, // Clear grace period on update
        cancelledAt: null, // Clear cancelled date
      },
    })

    return {
      id: sub.id,
      userId: sub.userId,
      provider: sub.provider,
      providerCustomerId: sub.providerCustomerId,
      providerSubscriptionId: sub.providerSubscriptionId,
      providerPlanId: sub.providerPlanId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelledAt: sub.cancelledAt,
      gracePeriodEndsAt: sub.gracePeriodEndsAt,
      trialEndsAt: sub.trialEndsAt,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    }
  }

  public async updateStatus(
    id: string,
    status: SubscriptionStatus,
    extra?: {
      readonly currentPeriodEnd?: Date
      readonly cancelledAt?: Date | null
      readonly gracePeriodEndsAt?: Date | null
    }
  ): Promise<SubscriptionRecord> {
    const sub = await this.prisma.subscription.update({
      where: { id },
      data: {
        status,
        ...(extra?.currentPeriodEnd !== undefined ? { currentPeriodEnd: extra.currentPeriodEnd } : {}),
        ...(extra?.cancelledAt !== undefined ? { cancelledAt: extra.cancelledAt } : {}),
        ...(extra?.gracePeriodEndsAt !== undefined ? { gracePeriodEndsAt: extra.gracePeriodEndsAt } : {}),
      },
    })

    return {
      id: sub.id,
      userId: sub.userId,
      provider: sub.provider,
      providerCustomerId: sub.providerCustomerId,
      providerSubscriptionId: sub.providerSubscriptionId,
      providerPlanId: sub.providerPlanId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelledAt: sub.cancelledAt,
      gracePeriodEndsAt: sub.gracePeriodEndsAt,
      trialEndsAt: sub.trialEndsAt,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    }
  }

  public async findActiveSubscriptions(): Promise<readonly SubscriptionRecord[]> {
    const list = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
    })

    return list.map((sub) => ({
      id: sub.id,
      userId: sub.userId,
      provider: sub.provider,
      providerCustomerId: sub.providerCustomerId,
      providerSubscriptionId: sub.providerSubscriptionId,
      providerPlanId: sub.providerPlanId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelledAt: sub.cancelledAt,
      gracePeriodEndsAt: sub.gracePeriodEndsAt,
      trialEndsAt: sub.trialEndsAt,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    }))
  }

  public async findGracePeriodSubscriptions(): Promise<readonly SubscriptionRecord[]> {
    const list = await this.prisma.subscription.findMany({
      where: { status: 'GRACE_PERIOD' },
    })

    return list.map((sub) => ({
      id: sub.id,
      userId: sub.userId,
      provider: sub.provider,
      providerCustomerId: sub.providerCustomerId,
      providerSubscriptionId: sub.providerSubscriptionId,
      providerPlanId: sub.providerPlanId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelledAt: sub.cancelledAt,
      gracePeriodEndsAt: sub.gracePeriodEndsAt,
      trialEndsAt: sub.trialEndsAt,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    }))
  }
}
