import { Migration } from '@mikro-orm/migrations';

/**
 * Baseline migration. It only proves the up/down pipeline end to end; the
 * domain schema arrives in the next migration.
 */
export class Migration20261111000000Init extends Migration {
  override name = 'Migration20261111000000_init';

  override up(): void {
    this.addSql(`comment on schema public is 'canopy wagering processor'`);
  }

  override down(): void {
    this.addSql(`comment on schema public is null`);
  }
}
