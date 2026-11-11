import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrations } from '../../database/migrations';

export interface OrmConnectionOptions {
  clientUrl: string;
  poolMax?: number;
  debug?: boolean;
}

/**
 * Single source of the ORM configuration, shared by the Nest app (app_user,
 * no DDL) and by scripts/migrate.ts (migrator user, owns the schema).
 *
 * Entities are registered explicitly and migrations are listed in code instead
 * of discovered from the filesystem: discovery by glob is the fragile part of
 * MikroORM under Bun, and an explicit list is easier to review anyway.
 */
export function buildOrmConfig(options: OrmConnectionOptions): Options {
  return defineConfig({
    clientUrl: options.clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 0, max: options.poolMax ?? 10 },
    debug: options.debug ?? false,
    allowGlobalContext: false,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: migrations,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
