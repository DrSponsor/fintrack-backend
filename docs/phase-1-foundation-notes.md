# Phase 1 Foundation Notes

## Runtime Target

The project runtime target is Node 24. This intentionally supersedes the original architecture document's Node 22 baseline for this repository. CI, local development, Docker images, and dependency type packages must stay aligned on Node 24.

## Retention Tables And NDPR Anonymisation

`AuditLog` and `BillingEvent` intentionally store `userId` as a denormalised string without a foreign-key relation.

The architecture requires these records to survive account deletion with `userId` replaced by a one-way hash. A hard foreign key to `users.id` would reject that update and would also block deletion of the user row. The Phase 1 schema therefore preserves the audit pointer while allowing the later NDPR deletion worker to anonymise safely.

## TimescaleDB Hypertable Timing

Phase 1 enables the TimescaleDB extension in local infrastructure, but does not convert `transactions` intoer a hypertable yet.

TimescaleDB requires every unique index on a hypertable to include the partitioning corlumn. The architecture also requires globally unique UUID IDs and globally unique `idempotencyKey`. Converting `transactions` directly without revisiting those constraints would create a migration that fails or weakens financial idempotency. The analysis phase must explicitly choose the final time-series design before hypertable conversion.

## Raw Snippet Encryption Naming

`Transaction.rawSnippetEnc` is used instead of `rawSnippet` because the engineering prompt mandates the `Enc` suffix for encrypted fields. The field is still the short-lived email snippet described by the architecture and remains scheduled for retention cleanup in a later phase.
