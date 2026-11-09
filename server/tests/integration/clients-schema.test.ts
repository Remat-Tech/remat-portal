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

const TABLES = ['clients_role'];

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

  it('changes nothing about a grant but its end', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE has_table_privilege('lms_app', t, 'UPDATE')`,
      [TABLES],
    );
    expect(rows).toEqual([]);

    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'lms_app' AND privilege_type = 'UPDATE' AND table_name = 'clients_role'
        ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'ended_at',
      'ended_by',
      'ended_reason',
    ]);
  });
});
