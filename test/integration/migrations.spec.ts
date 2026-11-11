import { afterAll, describe, expect, it } from 'bun:test';
import { openAdminSql } from '../support/db';
import { migrate } from '../support/migrations';

describe('migrations', () => {
  const sql = openAdminSql();

  afterAll(async () => {
    await migrate('up');
    await sql.close();
  });

  it('revert everything and re-apply cleanly (reversible and repeatable)', async () => {
    await migrate('up');
    await migrate('down', 'all');
    const [afterDown] = await sql`select count(*)::int as n from mikro_orm_migrations`;
    expect(afterDown.n).toBe(0);

    await migrate('up');
    const executed = await sql`select name from mikro_orm_migrations order by id`;
    expect(executed.length).toBeGreaterThan(0);
    expect(await migrate('up')).toContain('nothing to apply');
  });
});
