import { Migration20261111000000Init } from './Migration20261111000000_init';

/**
 * Ordered list of migrations. A new migration is only picked up after it is
 * added here (scripts/migrate.ts create prints the line to add).
 */
export const migrations = [Migration20261111000000Init];
