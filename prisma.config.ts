import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
    // The installed @prisma/config's `Datasource` type only declares `url`
    // and `shadowDatabaseUrl` — its .d.ts hasn't caught up to `directUrl`,
    // which the Prisma CLI itself both supports and generated here. Without
    // it, migrations would run through PgBouncer's transaction pooler
    // instead of connecting directly to Postgres, which Prisma's migration
    // engine requires.
    // @ts-expect-error — see comment above; remove once @prisma/config ships directUrl in its types.
    directUrl: env('DIRECT_URL'),
  },
  migrations: {
    seed: 'npx tsx prisma/seed.ts',
  },
})
