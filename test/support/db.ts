import { SQL } from 'bun';
import { testEnv } from './env';

/**
 * Direct SQL access for assertions: tests check the database itself, never
 * through the ORM the code under test uses. Connects as the migrator role so
 * fixtures can TRUNCATE and tamper with data when a test needs to.
 */
export function openAdminSql(url = testEnv.migratorDatabaseUrl()): SQL {
  return new SQL({ url, max: 4 });
}
