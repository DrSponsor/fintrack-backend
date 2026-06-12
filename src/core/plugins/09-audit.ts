import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'

function shouldAudit(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

export const auditPlugin: FastifyPluginCallback = fp((fastify, _options, done) => {
  fastify.addHook('onSend', async (request, _reply, payload) => {
    if (!shouldAudit(request.method) || request.user === undefined) {
      return payload
    }

    const auditConfig = request.routeOptions.config.audit
    const action = auditConfig?.action ?? `${request.method} ${request.routeOptions.url}`
    const resourceType = auditConfig?.resourceType ?? 'unknown'

    try {
      await fastify.db.primary.auditLog.create({
        data: {
          requestId: request.requestId,
          userId: request.user.sub,
          action,
          resourceType,
          resourceId: 'unknown',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? 'unknown',
          metadata: {
            method: request.method,
            url: request.url,
          },
        },
      })
    } catch (error) {
      request.log.error({ err: error }, 'audit log write failed')
    }

    return payload
  })
  done()
}, {
  name: '09-audit',
  dependencies: ['04-database', '07-auth'],
})
