import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The clients tables, against a real database. #274, Clients TDD 4.8 and 14.
 *
 * Only what the schema decides on its own. So far that is the roles: who holds which, who
 * granted it and when, ended rather than deleted, and what lms_app may change.
 */

const testDatabaseUrl = await databaseForThisFile();

let admin: Client;
let sysadmin: string;
let ama: string;
let kofi: string;

const TABLES = ['clients_role', 'clients_product_line', 'clients_product'];

beforeAll(async () => {
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const people = (await seed(admin)) as Record<string, string>;
  sysadmin = people.ceo;

  const { rows } = await admin.query<{ id: string }>(
    'SELECT id FROM employee WHERE id <> $1 ORDER BY id LIMIT 2',
    [sysadmin],
  );
  [ama, kofi] = rows.map((row) => row.id);
});

afterAll(async () => {
  await admin?.end();
});

/* Each test in a transaction of its own, rolled back afterwards, which is also what lets a
   refused statement be undone to a savepoint. */
beforeEach(async () => {
  await admin.query('BEGIN');
  return async () => {
    await admin.query('ROLLBACK');
  };
});

/** The constraint or index a statement was refused by, or null if it went in. */
async function refusedBy(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await admin.query('SAVEPOINT attempt');
    await admin.query(sql, params);
    await admin.query('RELEASE SAVEPOINT attempt');
    return null;
  } catch (error) {
    await admin.query('ROLLBACK TO SAVEPOINT attempt').catch(() => undefined);
    return (error as { constraint?: string }).constraint ?? String(error);
  }
}

/* ---------------------------------------------------------------------- roles */

describe('a role', () => {
  const GRANT = `INSERT INTO clients_role (employee_id, role, granted_by)
                 VALUES ($1, $2, $3) RETURNING id`;

  /** Ends a grant as somebody, for a reason. */
  async function end(id: string, reason = 'REVOKED', by: string | null = sysadmin): Promise<void> {
    await admin.query(
      `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = $3 WHERE id = $1`,
      [id, by, reason],
    );
  }

  it('records who holds it, who granted it and when', async () => {
    const { rows } = await admin.query<{ granted_at: Date }>(
      `INSERT INTO clients_role (employee_id, role, granted_by)
       VALUES ($1, 'ASSOCIATE', $2) RETURNING employee_id, role, granted_by, granted_at`,
      [ama, sysadmin],
    );

    expect(rows[0]).toMatchObject({ employee_id: ama, role: 'ASSOCIATE', granted_by: sysadmin });
    expect(rows[0].granted_at).toBeInstanceOf(Date);
  });

  it('is granted by somebody', async () => {
    expect(await refusedBy(GRANT, [ama, 'ASSOCIATE', null])).toMatch(/granted_by/);
  });

  it('is only BD manager or associate', async () => {
    expect(await refusedBy(GRANT, [ama, 'VIEWER', sysadmin])).toBe('clients_role_role_check');
    expect(await refusedBy(GRANT, [ama, 'BD_MANAGER', sysadmin])).toBeNull();
    expect(await refusedBy(GRANT, [kofi, 'ASSOCIATE', sysadmin])).toBeNull();
  });

  /* #274. Not SRS CLI 89: there is no limit of one, because the department will grow. */
  it('may be BD manager for several people at once', async () => {
    expect(await refusedBy(GRANT, [ama, 'BD_MANAGER', sysadmin])).toBeNull();
    expect(await refusedBy(GRANT, [kofi, 'BD_MANAGER', sysadmin])).toBeNull();

    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*) FROM clients_role WHERE role = 'BD_MANAGER' AND ended_at IS NULL`,
    );
    expect(rows[0].count).toBe('2');
  });

  it('is held once at a time, and granted again once ended', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [ama, 'ASSOCIATE', sysadmin]);

    expect(await refusedBy(GRANT, [ama, 'ASSOCIATE', sysadmin])).toBe('uq_clients_role_live');

    await end(rows[0].id);

    expect(await refusedBy(GRANT, [ama, 'ASSOCIATE', sysadmin])).toBeNull();
  });

  it('ends revoked or because its holder left, and says which', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [kofi, 'ASSOCIATE', sysadmin]);
    const END = `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = $3
                  WHERE id = $1`;

    expect(await refusedBy(END, [rows[0].id, sysadmin, null])).toBe(
      'clients_role_ends_with_a_reason',
    );
    expect(await refusedBy(END, [rows[0].id, sysadmin, 'RETIRED'])).toBe(
      'clients_role_ending_known',
    );
    expect(
      await refusedBy(`UPDATE clients_role SET ended_reason = 'LEFT' WHERE id = $1`, [rows[0].id]),
    ).toBe('clients_role_ends_with_a_reason');
  });

  /* CLI 95. Leaving ends a grant with nobody behind it; withdrawing one is somebody's act. */
  it('is revoked by somebody, but may end with nobody when its holder left', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [kofi, 'ASSOCIATE', sysadmin]);
    const END = `UPDATE clients_role SET ended_at = now(), ended_by = NULL, ended_reason = $2
                  WHERE id = $1`;

    expect(await refusedBy(END, [rows[0].id, 'REVOKED'])).toBe('clients_role_revoked_by_someone');
    expect(await refusedBy(END, [rows[0].id, 'LEFT'])).toBeNull();
  });

  it('ends after it was granted', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [kofi, 'ASSOCIATE', sysadmin]);

    expect(
      await refusedBy(
        `UPDATE clients_role
            SET ended_at = granted_at - interval '1 day', ended_by = $2, ended_reason = 'REVOKED'
          WHERE id = $1`,
        [rows[0].id, sysadmin],
      ),
    ).toBe('clients_role_ends_after_granted');
  });

  it('keeps its history: an ended grant is still there', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [ama, 'ASSOCIATE', sysadmin]);

    await end(rows[0].id);
    await admin.query(GRANT, [ama, 'ASSOCIATE', sysadmin]);

    const history = await admin.query<{ ended_reason: string | null }>(
      `SELECT ended_reason FROM clients_role WHERE employee_id = $1 ORDER BY id`,
      [ama],
    );
    expect(history.rows).toEqual([{ ended_reason: 'REVOKED' }, { ended_reason: null }]);
  });

  it('is found by person, among the live grants', async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_role_person'`,
    );

    expect(rows[0]?.indexdef).toMatch(
      /ON public\.clients_role USING btree \(employee_id\) WHERE \(ended_at IS NULL\)/,
    );
  });
});

/* ---------------------------------------------------------- lines and products, #293 */

describe('a product line and its products', () => {
  /* Names no seeded line or product has, so these tests stand whatever the seed holds. */
  const LINE = `INSERT INTO clients_product_line (name) VALUES ($1) RETURNING id`;
  const PRODUCT = `INSERT INTO clients_product (line_id, name) VALUES ($1, $2) RETURNING id`;

  async function aLine(name = 'Testline'): Promise<string> {
    return (await admin.query<{ id: string }>(LINE, [name])).rows[0].id;
  }

  it('puts every product in exactly one line that exists', async () => {
    const line = await aLine();

    expect(await refusedBy(PRODUCT, [line, 'Testproduct'])).toBeNull();
    expect(await refusedBy(PRODUCT, [null, 'Lineless'])).toMatch(/line_id/);
    expect(await refusedBy(PRODUCT, ['987654321', 'Nowhere'])).toBe('clients_product_line_id_fkey');
  });

  it('names each once, ignoring case and surrounding spaces', async () => {
    const line = await aLine();

    expect(await refusedBy(LINE, ['  testLINE '])).toBe('uq_clients_line_name');
    expect(await refusedBy(PRODUCT, [line, 'Testproduct'])).toBeNull();
    expect(await refusedBy(PRODUCT, [line, 'TESTPRODUCT  '])).toBe('uq_clients_product_name');
  });

  it('may give a product the name of its line, as Cloud9 and Riskflow are', async () => {
    const line = await aLine();

    expect(await refusedBy(PRODUCT, [line, 'Testline'])).toBeNull();
  });

  it('is never nameless', async () => {
    const line = await aLine();

    expect(await refusedBy(LINE, ['   '])).toBe('clients_line_named');
    expect(await refusedBy(PRODUCT, [line, ''])).toBe('clients_product_named');
  });

  it('is written to the audit log by the database, with who did it', async () => {
    await admin.query(
      `SELECT set_config('lms.audit.actor', 'employee 7', true),
              set_config('lms.audit.actor_employee_id', $1, true)`,
      [sysadmin],
    );
    const line = await aLine();
    const { rows } = await admin.query<{ id: string }>(PRODUCT, [line, 'Testproduct']);
    await admin.query(`UPDATE clients_product SET retired_on = '2026-11-09' WHERE id = $1`, [
      rows[0].id,
    ]);

    const log = await admin.query(
      `SELECT entity, action, entity_id, actor_employee_id FROM audit_log
        WHERE entity IN ('clients_product_line', 'clients_product') ORDER BY id`,
    );
    expect(log.rows).toEqual([
      {
        entity: 'clients_product_line',
        action: 'CREATE',
        entity_id: line,
        actor_employee_id: sysadmin,
      },
      {
        entity: 'clients_product',
        action: 'CREATE',
        entity_id: rows[0].id,
        actor_employee_id: sysadmin,
      },
      {
        entity: 'clients_product',
        action: 'UPDATE',
        entity_id: rows[0].id,
        actor_employee_id: sysadmin,
      },
    ]);
  });
});

/* ------------------------------------------- a retired product takes no new deals, #293 */

/* The opportunities table does not exist yet. A stand in with the one column the rule reads, and
   the trigger attached exactly as the opportunities migration attaches it. CLI 08. */
describe('a retired product', () => {
  const DEAL = 'INSERT INTO deal (product_id) VALUES ($1) RETURNING id';

  async function aProduct(
    line = 'Dealline',
    product = 'Dealproduct',
  ): Promise<{ line: string; product: string }> {
    const lineId = (
      await admin.query<{ id: string }>(
        'INSERT INTO clients_product_line (name) VALUES ($1) RETURNING id',
        [line],
      )
    ).rows[0].id;
    const productId = (
      await admin.query<{ id: string }>(
        'INSERT INTO clients_product (line_id, name) VALUES ($1, $2) RETURNING id',
        [lineId, product],
      )
    ).rows[0].id;

    await admin.query(
      'CREATE TEMP TABLE deal (id SERIAL PRIMARY KEY, product_id BIGINT, note TEXT) ON COMMIT DROP',
    );
    await admin.query(
      'CREATE TRIGGER deal_product_takes_new_deals BEFORE INSERT OR UPDATE OF product_id ON deal ' +
        'FOR EACH ROW EXECUTE FUNCTION clients_product_takes_new_deals()',
    );

    return { line: lineId, product: productId };
  }

  async function retire(table: 'clients_product' | 'clients_product_line', id: string) {
    await admin.query(`UPDATE ${table} SET retired_on = '2026-10-30' WHERE id = $1`, [id]);
  }

  it('takes new deals while it is not retired', async () => {
    const { product } = await aProduct();

    expect(await refusedBy(DEAL, [product])).toBeNull();
  });

  it('takes no new deal once retired, and says so by name', async () => {
    const { product } = await aProduct();
    await retire('clients_product', product);

    expect(await refusedBy(DEAL, [product])).toBe('clients_product_takes_new_deals');

    await admin.query('SAVEPOINT why');
    await expect(admin.query(DEAL, [product])).rejects.toThrow(
      'Dealproduct is retired, so it takes no new deals.',
    );
    await admin.query('ROLLBACK TO SAVEPOINT why');
  });

  it('takes no new deal while its line is retired, even if restored by hand', async () => {
    const { line, product } = await aProduct();
    await retire('clients_product_line', line);

    expect(await refusedBy(DEAL, [product])).toBe('clients_product_takes_new_deals');
  });

  it('keeps every deal it already had, which carries on and can still be changed', async () => {
    const { product } = await aProduct();
    const deal = (await admin.query<{ id: string }>(DEAL, [product])).rows[0].id;
    await retire('clients_product', product);

    expect(
      await refusedBy("UPDATE deal SET note = 'still going' WHERE id = $1", [deal]),
    ).toBeNull();
    expect((await admin.query('SELECT count(*)::int AS n FROM deal')).rows[0].n).toBe(1);
  });

  it('takes no deal moved onto it from another product', async () => {
    const live = await aProduct('Liveline', 'Liveproduct');
    const deal = (await admin.query<{ id: string }>(DEAL, [live.product])).rows[0].id;
    const old = (
      await admin.query<{ id: string }>(
        "INSERT INTO clients_product (line_id, name, retired_on) VALUES ($1, 'Oldproduct', '2026-01-01') RETURNING id",
        [live.line],
      )
    ).rows[0].id;

    expect(await refusedBy('UPDATE deal SET product_id = $2 WHERE id = $1', [deal, old])).toBe(
      'clients_product_takes_new_deals',
    );
  });
});

/* --------------------------------------------------- the lines sold today, #293 */

describe('the product lines as migrated', () => {
  it('are the four lines sold today, each product in its line', async () => {
    const { rows } = await admin.query<{ line: string; product: string }>(
      `SELECT l.name AS line, p.name AS product
         FROM clients_product_line l JOIN clients_product p ON p.line_id = l.id
        WHERE l.retired_on IS NULL AND p.retired_on IS NULL`,
    );
    const byLine: Record<string, string[]> = {};
    for (const { line, product } of rows) (byLine[line] ??= []).push(product);
    for (const products of Object.values(byLine)) products.sort();

    expect(byLine).toEqual({
      Symphony: ['Cloud9', 'Federation', 'Messaging'],
      'Dura Capital': ['CreditStudio', 'MicroStudio', 'OnboardStudio'],
      Riskflow: ['ALM', 'Treasury'],
      'AIC One': [
        'ComplyOn',
        'EngageNet',
        'Orcaa.ai',
        'Proba Analytics',
        'Proba Workflows',
        'X-Verdict',
      ],
    });
  });
});

/* ---------------------------------------------------------- what lms_app may do */

describe('the application role', () => {
  it('deletes nothing in clients', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE has_table_privilege('lms_app', t, 'DELETE')
           OR has_table_privilege('lms_app', t, 'TRUNCATE')`,
      [TABLES],
    );

    expect(rows).toEqual([]);
  });

  it('reads and appends to every table', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE NOT has_table_privilege('lms_app', t, 'SELECT')
           OR NOT has_table_privilege('lms_app', t, 'INSERT')`,
      [TABLES],
    );

    expect(rows).toEqual([]);
  });

  /* A grant is ended and nothing else; a line or product is renamed and retired, and a product
     never changes line. No table may be updated whole. */
  it('changes only the columns each table is meant to change', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE has_table_privilege('lms_app', t, 'UPDATE')`,
      [TABLES],
    );
    expect(rows).toEqual([]);

    const columns = await admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'lms_app' AND privilege_type = 'UPDATE' AND table_name = ANY($1)
        ORDER BY table_name, column_name`,
      [TABLES],
    );
    expect(columns.rows).toEqual([
      { table_name: 'clients_product', column_name: 'name' },
      { table_name: 'clients_product', column_name: 'retired_on' },
      { table_name: 'clients_product_line', column_name: 'name' },
      { table_name: 'clients_product_line', column_name: 'retired_on' },
      { table_name: 'clients_role', column_name: 'ended_at' },
      { table_name: 'clients_role', column_name: 'ended_by' },
      { table_name: 'clients_role', column_name: 'ended_reason' },
    ]);
  });
});
