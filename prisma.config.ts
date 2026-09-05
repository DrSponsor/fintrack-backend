import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Migrations must NOT go through PgBouncer. The migration engine needs a
    // session it can hold, and the transaction pooler will not give it one —
    // so this is DIRECT_URL, never DATABASE_URL.
    //
    // It used to be DATABASE_URL with a `directUrl` beside it, suppressed by
    // a ts-expect-error comment. That field does not exist: @prisma/config
    // declares only `url` and `shadowDatabaseUrl`, and Prisma 7 removed `url`
    // from schema files too, so there was nowhere for it to take effect. It
    // silently did nothing, and `migrate deploy` announced it was connecting
    // on the pooler port. The suppression comment is what hid it.
    //
    // Not `?? env('DATABASE_URL')`: env() returns string and throws when a
    // variable is missing, so a fallback would never run. The env schema
    // requires DIRECT_URL anyway.
    url: env('DIRECT_URL'),
  },
  migrations: {
    seed: 'npx tsx prisma/seed.ts',
  },
})
