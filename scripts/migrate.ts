/**
 * Migration CLI, used instead of the MikroORM CLI (more predictable under Bun).
 *
 *   bun scripts/migrate.ts up            apply every pending migration
 *   bun scripts/migrate.ts down [n]      revert the last n migrations (default 1)
 *   bun scripts/migrate.ts down all      revert everything
 *   bun scripts/migrate.ts status        list executed and pending migrations
 *   bun scripts/migrate.ts create <name> write a blank migration file
 *
 * Connects with MIGRATOR_DATABASE_URL: the app role has no DDL rights.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../src/shared/infrastructure/mikro-orm.config';

const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'database', 'migrations');

function createMigration(name: string | undefined): void {
  if (!name || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error('usage: migrate.ts create <snake_case_name>');
  }
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const className = `Migration${stamp}${name.replace(/(^|_)(\w)/g, (_m, _s, c: string) => c.toUpperCase())}`;
  const fileName = `Migration${stamp}_${name}`;
  const body = `import { Migration } from '@mikro-orm/migrations';

export class ${className} extends Migration {
  override name = '${fileName}';

  override up(): void {
    this.addSql(\`\`);
  }

  override down(): void {
    this.addSql(\`\`);
  }
}
`;
  writeFileSync(join(MIGRATIONS_DIR, `${fileName}.ts`), body, { flag: 'wx' });
  console.log(`created src/database/migrations/${fileName}.ts`);
  console.log(`register it in src/database/migrations/index.ts: import { ${className} } from './${fileName}';`);
}

async function main(): Promise<void> {
  const [command = 'up', arg] = process.argv.slice(2);
  if (command === 'create') return createMigration(arg);

  const clientUrl = process.env.MIGRATOR_DATABASE_URL;
  if (!clientUrl) throw new Error('MIGRATOR_DATABASE_URL is not set');

  const orm = await MikroORM.init(buildOrmConfig({ clientUrl, poolMax: 2 }));
  try {
    const migrator = orm.migrator;
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(applied.length ? `applied: ${applied.map((m) => m.name).join(', ')}` : 'nothing to apply');
        break;
      }
      case 'down': {
        const reverted = [];
        if (arg === 'all') {
          reverted.push(...(await migrator.down({ to: 0 })));
        } else {
          const steps = Number.parseInt(arg ?? '1', 10);
          for (let i = 0; i < steps; i++) reverted.push(...(await migrator.down()));
        }
        console.log(reverted.length ? `reverted: ${reverted.map((m) => m.name).join(', ')}` : 'nothing to revert');
        break;
      }
      case 'status': {
        const executed = await migrator.getExecuted();
        const pending = await migrator.getPending();
        console.log({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) });
        break;
      }
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
