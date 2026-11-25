import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * Meeting reports over HTTP, against a real database. #291, Clients SRS CLI 79 to CLI 82.
 *
 * Today is {@link PINNED_DATE}, 30 October 2026.
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;

let bdManager: Asker;
let associate: Asker;
let colleague: Asker;
let nobody: Asker;

const TODAY = PINNED_DATE;
const ROLE_BEGAN = '2026-09-01';

interface Report {
  id: string;
  author: { id: string; name: string };
  period: { from: string; to: string };
  status: string;
  sharedAt: string | null;
}

interface Mine {
  reports: Report[];
  draftId: string | null;
  nextPeriod: { from: string; to: string };
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  app = await startClientsApp(db, denials);
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;

  const grants = new ClientsRoleRepository(db);
  await grants.grant(people.commercialDirector, 'BD_MANAGER', people.headOfHr, 'them');
  await grants.grant(people.officer, 'ASSOCIATE', people.headOfHr, 'them');
  await grants.grant(people.teamLead, 'ASSOCIATE', people.headOfHr, 'them');
  /* Granted on a known day, not the real one, which is after the pinned today. */
  await admin.query(`UPDATE clients_role SET granted_at = $1`, [`${ROLE_BEGAN}T09:00:00Z`]);

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  colleague = { employeeId: people.teamLead };
  nobody = { employeeId: people.engineer };

  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

async function mine(as: Asker): Promise<Mine> {
  const response = await app.send('GET', '/api/clients/meeting-reports', as);
  expect(response.status).toBe(200);

  return (await response.json()) as Mine;
}

/** A report shared already, written straight to the table: sharing comes later in #291. */
async function aSharedReport(author: string, from: string, to: string, sharedAt: string) {
  await admin.query(
    `INSERT INTO clients_meeting_report
            (author_id, period_from, period_to, status, shared_at, figures)
     VALUES ($1, $2, $3, 'SHARED', $4, '{}')`,
    [author, from, to, sharedAt],
  );
}

describe('the period a new report is offered', () => {
  it('runs from the day their role began to today, for a first report', async () => {
    expect(await mine(associate)).toEqual({
      reports: [],
      shared: null,
      draftId: null,
      nextPeriod: { from: ROLE_BEGAN, to: TODAY },
    });
  });

  it('runs from the day their current grant began, not an earlier one that ended', async () => {
    await admin.query(
      `UPDATE clients_role SET granted_at = '2026-10-01T09:00:00Z' WHERE employee_id = $1`,
      [people.officer],
    );
    await admin.query(
      `INSERT INTO clients_role (employee_id, role, granted_by, granted_at, ended_at, ended_by,
                                 ended_reason)
       VALUES ($1, 'ASSOCIATE', $2, '2026-01-05T09:00:00Z', '2026-03-01T09:00:00Z', $2, 'REVOKED')`,
      [people.officer, people.headOfHr],
    );

    expect((await mine(associate)).nextPeriod).toEqual({ from: '2026-10-01', to: TODAY });
  });

  it('runs from the day after the period of the report they shared most recently', async () => {
    await aSharedReport(people.officer, '2026-10-06', '2026-10-20', '2026-10-21T10:00:00Z');
    /* Shared later, though it covers earlier days. */
    await aSharedReport(people.officer, '2026-09-28', '2026-10-10', '2026-10-25T10:00:00Z');

    expect((await mine(associate)).nextPeriod).toEqual({ from: '2026-10-11', to: TODAY });
  });

  it('is today alone where the one they shared last ran to today', async () => {
    await aSharedReport(people.officer, '2026-10-20', TODAY, '2026-10-30T08:00:00Z');

    expect((await mine(associate)).nextPeriod).toEqual({ from: TODAY, to: TODAY });
  });

  it("is not moved by somebody else's reports", async () => {
    await aSharedReport(people.teamLead, '2026-10-01', '2026-10-20', '2026-10-21T10:00:00Z');

    expect((await mine(associate)).nextPeriod).toEqual({ from: ROLE_BEGAN, to: TODAY });
  });
});

describe('drafting a report', () => {
  it('drafts one for the period offered when none is given', async () => {
    const response = await app.send('POST', '/api/clients/meeting-reports', associate, {});
    expect(response.status).toBe(201);

    const report = (await response.json()) as Report;
    expect(report).toMatchObject({
      author: { id: people.officer },
      period: { from: ROLE_BEGAN, to: TODAY },
      status: 'DRAFT',
      sharedAt: null,
    });

    expect(await mine(associate)).toMatchObject({
      reports: [{ id: report.id, status: 'DRAFT' }],
      draftId: report.id,
    });
  });

  it('drafts one for the period asked for', async () => {
    const response = await app.send('POST', '/api/clients/meeting-reports', associate, {
      from: '2026-10-19',
      to: '2026-10-23',
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as Report).period).toEqual({
      from: '2026-10-19',
      to: '2026-10-23',
    });
  });

  it('may cover days a shared report covered', async () => {
    await aSharedReport(people.officer, '2026-10-01', '2026-10-20', '2026-10-21T10:00:00Z');

    const response = await app.send('POST', '/api/clients/meeting-reports', associate, {
      from: '2026-10-15',
    });
    expect(response.status).toBe(201);
  });

  it('refuses a period ending after today, or starting after it ends', async () => {
    const later = await app.send('POST', '/api/clients/meeting-reports', associate, {
      to: '2026-10-31',
    });
    expect(later.status).toBe(400);
    expect(await later.json()).toMatchObject({ error: 'InvalidMeetingReport', field: 'to' });

    const backwards = await app.send('POST', '/api/clients/meeting-reports', associate, {
      from: '2026-10-20',
      to: '2026-10-19',
    });
    expect(backwards.status).toBe(400);
    expect(await backwards.json()).toMatchObject({ error: 'InvalidMeetingReport', field: 'from' });

    expect((await mine(associate)).reports).toEqual([]);
  });

  it('keeps each author to one draft at a time', async () => {
    const first = await app.send('POST', '/api/clients/meeting-reports', associate, {});
    expect(first.status).toBe(201);

    const second = await app.send('POST', '/api/clients/meeting-reports', associate, {});
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'MeetingReportDraftOpen' });

    /* Somebody else's draft is no bar to theirs. */
    expect((await app.send('POST', '/api/clients/meeting-reports', colleague, {})).status).toBe(
      201,
    );
  });

  it('is open to a BD manager too, for a report of their own', async () => {
    const response = await app.send('POST', '/api/clients/meeting-reports', bdManager, {});
    expect(response.status).toBe(201);
    expect(((await response.json()) as Report).author.id).toBe(people.commercialDirector);
  });

  it('is nobody without a role', async () => {
    expect((await app.send('POST', '/api/clients/meeting-reports', nobody, {})).status).toBe(404);
    expect((await app.send('GET', '/api/clients/meeting-reports', nobody)).status).toBe(404);
  });
});

describe('reading a report', () => {
  it('is its author’s', async () => {
    const drafted = (await (
      await app.send('POST', '/api/clients/meeting-reports', associate, {})
    ).json()) as Report;

    const response = await app.send('GET', `/api/clients/meeting-reports/${drafted.id}`, associate);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ...drafted, contents: {}, tally: {} });
  });

  it('is not listed among anybody else’s', async () => {
    await app.send('POST', '/api/clients/meeting-reports', associate, {});

    expect((await mine(colleague)).reports).toEqual([]);
    expect((await mine(bdManager)).reports).toEqual([]);
  });

  it('answers 404 for a report there is not', async () => {
    for (const id of ['987654', 'nonsense']) {
      expect((await app.send('GET', `/api/clients/meeting-reports/${id}`, associate)).status).toBe(
        404,
      );
    }
  });
});

/* ------------------------------------------------------------- what a report holds */

describe('what a report holds', () => {
  /* October 2026, written straight to the tables with the moments each thing happened, so the
     edges of the period can be put exactly. */
  const FROM = '2026-10-01';
  const TO = '2026-10-31';

  interface Held extends Report {
    contents: {
      activities: { id: string; kind: string; happenedOn: string; deal: unknown }[];
      stageMoves: {
        id: string;
        from: string | null;
        to: string;
        movedOn: string;
        by: { id: string };
      }[];
      stepsDone: { id: string; doneOn: string }[];
      stepsOverdue: { id: string; dueOn: string; doneOn: string | null }[];
      pocs: {
        id: string;
        healthAtEnd: string;
        changes: { health: string; setOn: string }[];
        ended: unknown;
      }[];
    };
    tally: {
      activities: { kind: string; count: number }[];
      activitiesTotal: number;
      stageMoves: number;
      stepsDone: number;
      stepsOverdue: number;
      pocs: Record<string, number>;
      pocsTotal: number;
    };
  }

  async function aClient(owner: string, name: string): Promise<string> {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client (name, type_id, owner_id)
         SELECT $1, id, $2 FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
        [name, owner],
      )
    ).rows[0].id;
  }

  async function aDeal(client: string, owner: string, product = 'CreditStudio'): Promise<string> {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_opportunity (client_id, product_id, owner_id)
         SELECT $1, id, $2 FROM clients_product WHERE name = $3 RETURNING id`,
        [client, owner, product],
      )
    ).rows[0].id;
  }

  async function anActivity(client: string, by: string, on: string, kind = 'CALL', deal?: string) {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_activity (client_id, opportunity_id, kind, happened_on, logged_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [client, deal ?? null, kind, on, by],
      )
    ).rows[0].id;
  }

  async function aMove(deal: string, from: string | null, to: string, by: string, at: string) {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_stage_change
                (opportunity_id, from_stage, to_stage, to_outcome, changed_by, changed_at)
         VALUES ($1, $2, $3, 'OPEN', $4, $5) RETURNING id`,
        [deal, from, to, by, at],
      )
    ).rows[0].id;
  }

  async function aStep(
    client: string,
    owner: string,
    dueOn: string,
    madeAt: string,
    doneAt: string | null = null,
  ) {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_next_step (client_id, description, due_on, owner_id, source,
                                        created_by, created_at, done_at, done_by)
         VALUES ($1, 'Send the pricing', $2, $3, 'MANUAL', $3, $4, $5::timestamptz,
                 CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE $3::bigint END)
         RETURNING id`,
        [client, dueOn, owner, madeAt, doneAt],
      )
    ).rows[0].id;
  }

  /** A deal into a POC of its own, started on a day, On Track from 09:00 that day. */
  async function aPoc(deal: string, startedOn: string): Promise<string> {
    await admin.query('BEGIN');
    await admin.query(
      `UPDATE clients_opportunity SET has_poc = true, stage = 'CONTRACT_SIGNED' WHERE id = $1`,
      [deal],
    );
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_poc
              (client_id, line_id, client_type_id, cs_lead_id, started_on, decision_on, created_by)
       SELECT o.client_id, p.line_id, c.type_id, o.owner_id, $2::date, $2::date + 70, o.owner_id
         FROM clients_opportunity o
         JOIN clients_product p ON p.id = o.product_id
         JOIN clients_client c ON c.id = o.client_id
        WHERE o.id = $1
       RETURNING id`,
      [deal, startedOn],
    );
    await aHealth(rows[0].id, 'ON_TRACK', `${startedOn}T09:00:00Z`);
    await admin.query(`UPDATE clients_opportunity SET stage = 'POC', poc_id = $2 WHERE id = $1`, [
      deal,
      rows[0].id,
    ]);
    await admin.query('COMMIT');

    return rows[0].id;
  }

  async function aHealth(poc: string, health: string, at: string) {
    await admin.query(
      `INSERT INTO clients_poc_health (poc_id, health, set_by, set_at)
       SELECT $1, $2, cs_lead_id, $3 FROM clients_poc WHERE id = $1`,
      [poc, health, at],
    );
  }

  /**
   * The associate's draft for October, written straight to the table with no figures, which they
   * then update through the API, as their work in October stands now.
   */
  async function octoberReport(): Promise<Held> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_meeting_report (author_id, period_from, period_to, figures)
       VALUES ($1, $2, $3, '{}') RETURNING id`,
      [people.officer, FROM, TO],
    );
    const response = await app.send(
      'POST',
      `/api/clients/meeting-reports/${rows[0].id}/figures`,
      associate,
    );
    expect(response.status).toBe(200);

    return (await response.json()) as Held;
  }

  it('holds the activities they logged in the period, oldest first', async () => {
    const client = await aClient(people.officer, 'Ecobank');
    const deal = await aDeal(client, people.officer);

    const meeting = await anActivity(client, people.officer, '2026-10-28', 'MEETING', deal);
    const call = await anActivity(client, people.officer, FROM);
    const lastDay = await anActivity(client, people.officer, TO, 'DEMO');
    await anActivity(client, people.officer, '2026-09-30');
    await anActivity(client, people.officer, '2026-11-01');
    /* A colleague's, on the associate's own client. */
    await anActivity(client, people.teamLead, '2026-10-15');

    const report = await octoberReport();

    expect(report.contents.activities.map((one) => one.id)).toEqual([call, meeting, lastDay]);
    expect(report.contents.activities[1]).toMatchObject({
      kind: 'MEETING',
      happenedOn: '2026-10-28',
      deal: { id: deal, product: 'CreditStudio' },
    });
    expect(report.tally.activitiesTotal).toBe(3);
    expect(report.tally.activities).toContainEqual({ kind: 'CALL', count: 1 });
    expect(report.tally.activities).toContainEqual({ kind: 'MEETING', count: 1 });
    expect(report.tally.activities).toContainEqual({ kind: 'DEMO', count: 1 });
    expect(report.tally.activities).toContainEqual({ kind: 'NOTE', count: 0 });
  });

  it('holds the stage changes in the period on deals they own, whoever made them', async () => {
    const client = await aClient(people.officer, 'Ecobank');
    const theirs = await aDeal(client, people.officer);
    const colleagues = await aDeal(client, people.teamLead, 'OnboardStudio');

    const opened = await aMove(theirs, null, 'DISCOVERY', people.officer, '2026-10-01T00:00:00Z');
    const byBdm = await aMove(
      theirs,
      'DISCOVERY',
      'QUALIFICATION',
      people.commercialDirector,
      '2026-10-31T23:59:00Z',
    );
    await aMove(theirs, 'QUALIFICATION', 'PROPOSAL', people.officer, '2026-11-01T00:00:00Z');
    await aMove(theirs, null, 'DISCOVERY', people.officer, '2026-09-30T23:59:00Z');
    /* Made by them, on a deal that is not theirs. */
    await aMove(colleagues, null, 'DISCOVERY', people.officer, '2026-10-10T10:00:00Z');

    const report = await octoberReport();

    expect(report.contents.stageMoves.map((one) => one.id)).toEqual([opened, byBdm]);
    expect(report.contents.stageMoves[1]).toMatchObject({
      from: 'DISCOVERY',
      to: 'QUALIFICATION',
      movedOn: TO,
      by: { id: people.commercialDirector },
    });
    expect(report.tally.stageMoves).toBe(2);
  });

  it('holds the steps they closed in the period, and those overdue at its end', async () => {
    const client = await aClient(people.officer, 'Ecobank');
    const made = '2026-09-20T10:00:00Z';

    const closedIn = await aStep(
      client,
      people.officer,
      '2026-10-10',
      made,
      '2026-10-12T10:00:00Z',
    );
    /* Overdue at the end of October, closed only after it. */
    const closedAfter = await aStep(
      client,
      people.officer,
      '2026-10-20',
      made,
      '2026-11-03T10:00:00Z',
    );
    const stillOpen = await aStep(client, people.officer, '2026-09-25', made);
    /* Due on the last day is not yet late. */
    await aStep(client, people.officer, TO, made);
    /* Made after the period. */
    await aStep(client, people.officer, '2026-10-05', '2026-11-02T10:00:00Z');
    /* Closed before the period. */
    await aStep(client, people.officer, '2026-09-25', made, '2026-09-28T10:00:00Z');
    /* A colleague's. */
    await aStep(client, people.teamLead, '2026-10-10', made, '2026-10-12T10:00:00Z');

    const report = await octoberReport();

    expect(report.contents.stepsDone).toEqual([
      expect.objectContaining({ id: closedIn, doneOn: '2026-10-12' }),
    ]);
    expect(report.contents.stepsOverdue.map((one) => one.id)).toEqual([stillOpen, closedAfter]);
    expect(report.contents.stepsOverdue[1]).toMatchObject({ doneOn: '2026-11-03' });
    expect(report.tally).toMatchObject({ stepsDone: 1, stepsOverdue: 2 });
  });

  it('holds every POC they lead that ran in the period, with its health', async () => {
    const client = await aClient(people.officer, 'Ecobank');

    const earlier = await aPoc(await aDeal(client, people.officer, 'Messaging'), '2026-08-20');
    await aHealth(earlier, 'AT_RISK', '2026-09-15T10:00:00Z');
    await aHealth(earlier, 'STALLED', '2026-10-10T10:00:00Z');
    await aHealth(earlier, 'AT_RISK', '2026-11-02T10:00:00Z');

    const lastDay = await aPoc(await aDeal(client, people.officer, 'CreditStudio'), TO);
    /* Started after the period. */
    await aPoc(await aDeal(client, people.officer, 'OnboardStudio'), '2026-11-01');
    /* A colleague's. */
    await aPoc(await aDeal(client, people.teamLead, 'MicroStudio'), '2026-10-05');

    const report = await octoberReport();

    expect(report.contents.pocs.map((one) => one.id)).toEqual([earlier, lastDay]);
    expect(report.contents.pocs[0]).toMatchObject({
      healthAtEnd: 'STALLED',
      changes: [{ health: 'STALLED', setOn: '2026-10-10' }],
      ended: null,
    });
    expect(report.contents.pocs[1]).toMatchObject({
      healthAtEnd: 'ON_TRACK',
      changes: [{ health: 'ON_TRACK', setOn: TO }],
    });
    expect(report.tally).toMatchObject({
      pocs: { ON_TRACK: 1, AT_RISK: 0, STALLED: 1 },
      pocsTotal: 2,
    });
  });

  it('is empty where they did nothing in the period', async () => {
    const report = await octoberReport();

    expect(report.contents).toEqual({
      activities: [],
      stageMoves: [],
      stepsDone: [],
      stepsOverdue: [],
      pocs: [],
    });
    expect(report.tally.activitiesTotal).toBe(0);
  });

  it("is its author's work, whoever reads it", async () => {
    const client = await aClient(people.officer, 'Ecobank');
    await anActivity(client, people.officer, '2026-10-10');
    await anActivity(client, people.commercialDirector, '2026-10-10');

    /* Shared, so a BD manager may read it. Sharing comes later in #291. */
    const { id } = await octoberReport();
    await admin.query(
      `UPDATE clients_meeting_report SET status = 'SHARED', shared_at = now() WHERE id = $1`,
      [id],
    );
    const response = await app.send('GET', `/api/clients/meeting-reports/${id}`, bdManager);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Held).tally.activitiesTotal).toBe(1);
  });
});

/* ------------------------------------------------------ the figures saved with a report */

describe('the figures saved with a report', () => {
  interface Saved extends Report {
    contents: { activities: { client: { name: string } }[] };
    tally: { activitiesTotal: number };
    figuresAt: string;
    may: { change: boolean };
  }

  let client: string;

  beforeEach(async () => {
    client = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client (name, type_id, owner_id)
         SELECT 'Ecobank', id, $1 FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
        [people.officer],
      )
    ).rows[0].id;
  });

  async function aCall(on: string) {
    await admin.query(
      `INSERT INTO clients_activity (client_id, kind, happened_on, logged_by)
       VALUES ($1, 'CALL', $2, $3)`,
      [client, on, people.officer],
    );
  }

  async function draft(): Promise<Saved> {
    const response = await app.send('POST', '/api/clients/meeting-reports', associate, {});
    expect(response.status).toBe(201);

    return (await response.json()) as Saved;
  }

  async function read(id: string, as: Asker = associate): Promise<Saved> {
    const response = await app.send('GET', `/api/clients/meeting-reports/${id}`, as);
    expect(response.status).toBe(200);

    return (await response.json()) as Saved;
  }

  async function share(id: string) {
    await admin.query(
      `UPDATE clients_meeting_report SET status = 'SHARED', shared_at = now() WHERE id = $1`,
      [id],
    );
  }

  it('are saved as the draft starts, and read back as saved', async () => {
    await aCall('2026-10-05');
    const drafted = await draft();

    expect(drafted.tally.activitiesTotal).toBe(1);
    expect(drafted.may.change).toBe(true);
    expect(Date.parse(drafted.figuresAt)).not.toBeNaN();

    /* Things change afterwards: another call, and the client renamed. */
    await aCall('2026-10-06');
    await admin.query(`UPDATE clients_client SET name = 'Ecobank Ghana' WHERE id = $1`, [client]);

    const later = await read(drafted.id);
    expect(later.tally.activitiesTotal).toBe(1);
    expect(later.contents.activities[0].client.name).toBe('Ecobank');
    expect(later.figuresAt).toBe(drafted.figuresAt);
  });

  it('are saved afresh when its author updates them', async () => {
    const drafted = await draft();
    await aCall('2026-10-05');
    await admin.query(`UPDATE clients_client SET name = 'Ecobank Ghana' WHERE id = $1`, [client]);

    const response = await app.send(
      'POST',
      `/api/clients/meeting-reports/${drafted.id}/figures`,
      associate,
    );
    expect(response.status).toBe(200);

    const updated = (await response.json()) as Saved;
    expect(updated.tally.activitiesTotal).toBe(1);
    expect(updated.contents.activities[0].client.name).toBe('Ecobank Ghana');
    expect(Date.parse(updated.figuresAt)).toBeGreaterThanOrEqual(Date.parse(drafted.figuresAt));
    expect(await read(drafted.id)).toEqual(updated);
  });

  it('are fixed once it is shared', async () => {
    const drafted = await draft();
    await share(drafted.id);
    await aCall('2026-10-05');

    const response = await app.send(
      'POST',
      `/api/clients/meeting-reports/${drafted.id}/figures`,
      associate,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'MeetingReportShared' });

    const shared = await read(drafted.id);
    expect(shared.tally.activitiesTotal).toBe(0);
    expect(shared.may.change).toBe(false);
  });

  it('are updated by its author alone', async () => {
    const drafted = await draft();

    for (const somebody of [colleague, bdManager]) {
      expect(
        (await app.send('POST', `/api/clients/meeting-reports/${drafted.id}/figures`, somebody))
          .status,
      ).toBe(404);
    }

    /* Shared, a BD manager reads it, and still may not change it. */
    await share(drafted.id);
    expect((await read(drafted.id, bdManager)).may.change).toBe(false);
    expect(
      (await app.send('POST', `/api/clients/meeting-reports/${drafted.id}/figures`, bdManager))
        .status,
    ).toBe(403);
  });
});

/* ----------------------------------------------------- changing and discarding a draft */

describe('changing a draft', () => {
  interface Changed extends Report {
    tally: { activitiesTotal: number };
    figuresAt: string;
    may: { change: boolean };
  }

  async function aCall(on: string) {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_client (name, type_id, owner_id)
       SELECT 'Call ' || $1, id, $2 FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
      [on, people.officer],
    );
    await admin.query(
      `INSERT INTO clients_activity (client_id, kind, happened_on, logged_by)
       VALUES ($1, 'CALL', $2, $3)`,
      [rows[0].id, on, people.officer],
    );
  }

  async function draft(period: object = {}): Promise<Changed> {
    const response = await app.send('POST', '/api/clients/meeting-reports', associate, period);
    expect(response.status).toBe(201);

    return (await response.json()) as Changed;
  }

  function change(id: string, body: unknown, as: Asker = associate) {
    return app.send('PATCH', `/api/clients/meeting-reports/${id}`, as, body);
  }

  function discard(id: string, as: Asker = associate) {
    return app.send('POST', `/api/clients/meeting-reports/${id}/discard`, as);
  }

  it('takes a new period, and saves its figures afresh for it', async () => {
    await aCall('2026-10-05');
    await aCall('2026-10-20');
    const drafted = await draft({ from: '2026-10-15' });
    expect(drafted.tally.activitiesTotal).toBe(1);

    const response = await change(drafted.id, { from: '2026-10-01', to: '2026-10-10' });
    expect(response.status).toBe(200);

    const changed = (await response.json()) as Changed;
    expect(changed.period).toEqual({ from: '2026-10-01', to: '2026-10-10' });
    expect(changed.tally.activitiesTotal).toBe(1);
    expect(changed.status).toBe('DRAFT');
  });

  it('keeps a day left out as it was', async () => {
    const drafted = await draft({ from: '2026-10-15', to: '2026-10-25' });

    const changed = (await (await change(drafted.id, { to: '2026-10-28' })).json()) as Changed;
    expect(changed.period).toEqual({ from: '2026-10-15', to: '2026-10-28' });
  });

  it('changes nothing for the same period', async () => {
    const drafted = await draft({ from: '2026-10-15', to: '2026-10-25' });
    await aCall('2026-10-20');

    const same = (await (
      await change(drafted.id, { from: '2026-10-15', to: '2026-10-25' })
    ).json()) as Changed;
    expect(same.figuresAt).toBe(drafted.figuresAt);
    expect(same.tally.activitiesTotal).toBe(0);
  });

  it('refuses a period ending after today, or starting after it ends', async () => {
    const drafted = await draft({ from: '2026-10-15', to: '2026-10-25' });

    const later = await change(drafted.id, { to: '2026-10-31' });
    expect(later.status).toBe(400);
    expect(await later.json()).toMatchObject({ field: 'to' });

    const backwards = await change(drafted.id, { from: '2026-10-26' });
    expect(backwards.status).toBe(400);
    expect(await backwards.json()).toMatchObject({ field: 'from' });
  });

  it('is its author’s alone', async () => {
    const drafted = await draft();

    for (const somebody of [colleague, bdManager]) {
      expect((await change(drafted.id, { from: '2026-10-01' }, somebody)).status).toBe(404);
      expect((await discard(drafted.id, somebody)).status).toBe(404);
    }
    expect((await change(drafted.id, {}, nobody)).status).toBe(404);
  });

  it('is refused once it is shared', async () => {
    const drafted = await draft();
    await admin.query(
      `UPDATE clients_meeting_report SET status = 'SHARED', shared_at = now() WHERE id = $1`,
      [drafted.id],
    );

    for (const response of [
      await change(drafted.id, { from: '2026-10-01' }),
      await discard(drafted.id),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'MeetingReportShared' });
    }
  });
});

describe('discarding a draft', () => {
  async function draft(): Promise<string> {
    const response = await app.send('POST', '/api/clients/meeting-reports', associate, {});
    expect(response.status).toBe(201);

    return ((await response.json()) as Report).id;
  }

  it('keeps it, out of their list, and frees them to start another', async () => {
    const first = await draft();

    const response = await app.send(
      'POST',
      `/api/clients/meeting-reports/${first}/discard`,
      associate,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'DISCARDED', may: { change: false } });

    expect(await mine(associate)).toMatchObject({ reports: [], draftId: null });

    const second = await draft();
    expect(second).not.toBe(first);

    /* Kept, and read by its author by its address. */
    const kept = await app.send('GET', `/api/clients/meeting-reports/${first}`, associate);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({ status: 'DISCARDED' });
  });

  it('does not move the period a new report is offered', async () => {
    const first = await draft();
    await app.send('POST', `/api/clients/meeting-reports/${first}/discard`, associate);

    expect((await mine(associate)).nextPeriod).toEqual({ from: ROLE_BEGAN, to: TODAY });
  });

  it('leaves it as it was discarded', async () => {
    const first = await draft();
    await app.send('POST', `/api/clients/meeting-reports/${first}/discard`, associate);

    for (const response of [
      await app.send('POST', `/api/clients/meeting-reports/${first}/discard`, associate),
      await app.send('PATCH', `/api/clients/meeting-reports/${first}`, associate, {
        from: '2026-10-01',
      }),
      await app.send('POST', `/api/clients/meeting-reports/${first}/figures`, associate),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'MeetingReportDiscarded' });
    }
  });
});

/* ------------------------------------------------------------------ sharing a report */

describe('sharing a report', () => {
  interface Shared extends Report {
    tally: { activitiesTotal: number };
    figuresAt: string;
    may: { change: boolean };
  }

  interface Listed extends Mine {
    shared: Report[] | null;
  }

  beforeEach(async () => {
    await admin.query(`DELETE FROM email_outbox WHERE kind = 'CLIENTS_REPORT_SHARED'`);
  });

  async function aCall(on: string, by = people.officer) {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_client (name, type_id, owner_id)
       SELECT 'Call ' || $1 || ' ' || $2, id, $2::bigint FROM clients_client_type WHERE name = 'Bank'
       RETURNING id`,
      [on, by],
    );
    await admin.query(
      `INSERT INTO clients_activity (client_id, kind, happened_on, logged_by)
       VALUES ($1, 'CALL', $2, $3)`,
      [rows[0].id, on, by],
    );
  }

  async function draft(as: Asker = associate): Promise<Shared> {
    const response = await app.send('POST', '/api/clients/meeting-reports', as, {});
    expect(response.status).toBe(201);

    return (await response.json()) as Shared;
  }

  function share(id: string, as: Asker = associate) {
    return app.send('POST', `/api/clients/meeting-reports/${id}/share`, as);
  }

  async function listed(as: Asker): Promise<Listed> {
    const response = await app.send('GET', '/api/clients/meeting-reports', as);
    expect(response.status).toBe(200);

    return (await response.json()) as Listed;
  }

  async function emails() {
    return (
      await admin.query<{
        recipient_employee_id: string;
        to_address: string;
        subject: string;
        text_body: string;
        sender_employee_id: string;
        dedupe_key: string;
      }>(
        `SELECT recipient_employee_id, to_address, subject, text_body, sender_employee_id,
                dedupe_key
           FROM email_outbox WHERE kind = 'CLIENTS_REPORT_SHARED' ORDER BY id`,
      )
    ).rows;
  }

  async function workEmailOf(id: string): Promise<string> {
    return (
      await admin.query<{ work_email: string }>('SELECT work_email FROM employee WHERE id = $1', [
        id,
      ])
    ).rows[0].work_email;
  }

  it('saves its figures a last time and fixes it', async () => {
    const drafted = await draft();
    await aCall('2026-10-05');

    const response = await share(drafted.id);
    expect(response.status).toBe(200);

    const shared = (await response.json()) as Shared;
    expect(shared).toMatchObject({ status: 'SHARED', may: { change: false } });
    expect(shared.sharedAt).not.toBeNull();
    expect(shared.tally.activitiesTotal).toBe(1);

    /* Fixed: another call later changes nothing, and nothing may change it. */
    await aCall('2026-10-06');
    const again = await share(drafted.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'MeetingReportShared' });

    const read = await app.send('GET', `/api/clients/meeting-reports/${drafted.id}`, associate);
    expect(((await read.json()) as Shared).tally.activitiesTotal).toBe(1);
  });

  it('emails every BD manager once, with a link to it', async () => {
    await new ClientsRoleRepository(db).grant(
      people.teamLead,
      'BD_MANAGER',
      people.headOfHr,
      'them',
    );
    const drafted = await draft();

    await share(drafted.id);
    await share(drafted.id);

    const sent = await emails();
    expect(sent.map((email) => email.recipient_employee_id).sort()).toEqual(
      [people.commercialDirector, people.teamLead].sort(),
    );

    const toTheBdm = sent.find(
      (email) => email.recipient_employee_id === people.commercialDirector,
    )!;
    expect(toTheBdm).toMatchObject({
      to_address: await workEmailOf(people.commercialDirector),
      sender_employee_id: people.officer,
      dedupe_key: `CLIENTS_REPORT_SHARED:${drafted.id}:${people.commercialDirector}`,
    });
    expect(toTheBdm.subject).toMatch(/^Meeting report from /);
    expect(toTheBdm.text_body).toContain(`http://portal.test/#/clients/report/${drafted.id}`);
  });

  it('does not email a BD manager their own report', async () => {
    const drafted = await draft(bdManager);

    expect((await share(drafted.id, bdManager)).status).toBe(200);
    expect(await emails()).toEqual([]);
  });

  it('is its author’s alone to do, and only to a draft', async () => {
    const drafted = await draft();

    for (const somebody of [colleague, bdManager]) {
      expect((await share(drafted.id, somebody)).status).toBe(404);
    }
    expect((await share(drafted.id, nobody)).status).toBe(404);

    await app.send('POST', `/api/clients/meeting-reports/${drafted.id}/discard`, associate);
    const discarded = await share(drafted.id);
    expect(discarded.status).toBe(409);
    expect(await discarded.json()).toMatchObject({ error: 'MeetingReportDiscarded' });

    expect(await emails()).toEqual([]);
  });

  it('makes it readable and listed for a BD manager, and for nobody else', async () => {
    const drafted = await draft();

    /* A draft is nobody's but its author's: to anybody else it is not there. */
    expect(
      (await app.send('GET', `/api/clients/meeting-reports/${drafted.id}`, bdManager)).status,
    ).toBe(404);
    expect((await listed(bdManager)).shared).toEqual([]);

    await share(drafted.id);

    expect(
      (await app.send('GET', `/api/clients/meeting-reports/${drafted.id}`, bdManager)).status,
    ).toBe(200);
    expect((await listed(bdManager)).shared).toMatchObject([
      { id: drafted.id, author: { id: people.officer }, status: 'SHARED' },
    ]);
    /* Shared reports are not the BD manager's own. */
    expect((await listed(bdManager)).reports).toEqual([]);

    expect(
      (await app.send('GET', `/api/clients/meeting-reports/${drafted.id}`, colleague)).status,
    ).toBe(404);
    expect(await listed(colleague)).toMatchObject({ reports: [], shared: null });
  });

  it('moves the period the next report is offered to the day after', async () => {
    const response = await app.send('POST', '/api/clients/meeting-reports', associate, {
      from: '2026-10-01',
      to: '2026-10-20',
    });
    await share(((await response.json()) as Report).id);

    expect((await listed(associate)).nextPeriod).toEqual({ from: '2026-10-21', to: TODAY });
    expect((await listed(associate)).reports).toMatchObject([{ status: 'SHARED' }]);
  });
});

/* ------------------------------------------------------- who can see a report, by list or link */

describe('who can see a report', () => {
  async function draftOf(as: Asker): Promise<string> {
    const response = await app.send('POST', '/api/clients/meeting-reports', as, {});
    expect(response.status).toBe(201);

    return ((await response.json()) as Report).id;
  }

  async function sharedOf(as: Asker): Promise<string> {
    const id = await draftOf(as);
    expect((await app.send('POST', `/api/clients/meeting-reports/${id}/share`, as)).status).toBe(
      200,
    );

    return id;
  }

  async function listedIds(as: Asker): Promise<string[]> {
    const listed = (await (await app.send('GET', '/api/clients/meeting-reports', as)).json()) as {
      reports: Report[];
      shared: Report[] | null;
    };

    return [...listed.reports, ...(listed.shared ?? [])].map((report) => report.id);
  }

  /* #291, done when: another associate can't see it, by list or by link. */
  it('is not another associate’s, by list or by link, drafted or shared', async () => {
    const draft = await draftOf(associate);
    const nowhere = await app.send('GET', '/api/clients/meeting-reports/987654321', colleague);
    const missing = await nowhere.json();

    for (const id of [draft, await sharedOf(bdManager)]) {
      expect(await listedIds(colleague)).not.toContain(id);

      const byLink = await app.send('GET', `/api/clients/meeting-reports/${id}`, colleague);
      expect(byLink.status).toBe(404);
      /* Word for word what an id nobody has answers, so the link gives nothing away. */
      expect(await byLink.json()).toEqual(missing);
    }
  });

  it('is its author’s, and a BD manager’s once shared, by list and by link', async () => {
    const draft = await draftOf(associate);
    const shared = await sharedOf(colleague);

    expect((await listedIds(associate)).sort()).toEqual([draft]);
    expect((await listedIds(colleague)).sort()).toEqual([shared]);
    expect(await listedIds(bdManager)).toEqual([shared]);

    for (const [id, as] of [
      [draft, associate],
      [shared, colleague],
      [shared, bdManager],
    ] as const) {
      expect((await app.send('GET', `/api/clients/meeting-reports/${id}`, as)).status).toBe(200);
    }
    expect((await app.send('GET', `/api/clients/meeting-reports/${draft}`, bdManager)).status).toBe(
      404,
    );
  });

  it('stops being a BD manager’s when their role ends', async () => {
    const shared = await sharedOf(associate);
    await admin.query(
      `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = 'REVOKED'
        WHERE employee_id = $1 AND role = 'BD_MANAGER'`,
      [people.commercialDirector, people.headOfHr],
    );

    /* With no role left, the door turns them away before any report is looked for. */
    expect(
      (await app.send('GET', `/api/clients/meeting-reports/${shared}`, bdManager)).status,
    ).toBe(404);

    /* Still an associate: then theirs alone. */
    await new ClientsRoleRepository(db).grant(
      people.commercialDirector,
      'ASSOCIATE',
      people.headOfHr,
      'them',
    );
    expect(await listedIds(bdManager)).toEqual([]);
    expect(
      (await app.send('GET', `/api/clients/meeting-reports/${shared}`, bdManager)).status,
    ).toBe(404);
  });

  it('writes the refused look down, though it answers as if there were nothing', async () => {
    const draft = await draftOf(associate);
    denials.clear();

    await app.send('GET', `/api/clients/meeting-reports/${draft}`, colleague);
    expect(denials.last()).toMatchObject({
      employeeId: people.teamLead,
      action: 'readMeetingReport',
      subject: draft,
    });

    /* An id nobody has is nothing to write down. */
    denials.clear();
    await app.send('GET', '/api/clients/meeting-reports/987654321', colleague);
    expect(denials.entries).toEqual([]);
  });

  it('is never changed by anybody but its author, who is told it is not there', async () => {
    const draft = await draftOf(associate);

    for (const [method, path, body] of [
      ['PATCH', `/api/clients/meeting-reports/${draft}`, { from: '2026-10-01' }],
      ['POST', `/api/clients/meeting-reports/${draft}/figures`, undefined],
      ['POST', `/api/clients/meeting-reports/${draft}/share`, undefined],
      ['POST', `/api/clients/meeting-reports/${draft}/discard`, undefined],
    ] as const) {
      const response = await app.send(method, path, colleague, body);
      expect(response.status).toBe(404);
    }

    const still = await app.send('GET', `/api/clients/meeting-reports/${draft}`, associate);
    expect(await still.json()).toMatchObject({ status: 'DRAFT', period: { from: ROLE_BEGAN } });
  });
});

/* ------------------------------------------------------------------- the written sections */

describe('the written sections', () => {
  interface Written extends Report {
    sections: { key: string; heading: string; body: string | null }[];
  }

  async function draft(): Promise<Written> {
    const response = await app.send('POST', '/api/clients/meeting-reports', associate, {});
    expect(response.status).toBe(201);

    return (await response.json()) as Written;
  }

  function write(id: string, sections: unknown, as: Asker = associate) {
    return app.send('PATCH', `/api/clients/meeting-reports/${id}/sections`, as, { sections });
  }

  it('start as the four placeholders, each empty', async () => {
    expect((await draft()).sections).toEqual([
      { key: 'PROGRESS', heading: 'Progress and wins', body: null },
      { key: 'BLOCKERS', heading: 'Blockers and where I need help', body: null },
      { key: 'NEXT_PERIOD', heading: 'Plan for the next period', body: null },
      { key: 'OTHER', heading: 'Anything else', body: null },
    ]);
  });

  it('are written by its author, those left out kept', async () => {
    const drafted = await draft();

    expect(
      (await write(drafted.id, { PROGRESS: 'Signed ADB.', OTHER: 'Leave next week.' })).status,
    ).toBe(200);
    const response = await write(drafted.id, { OTHER: null, BLOCKERS: 'Waiting on legal.' });
    expect(response.status).toBe(200);

    const written = (await response.json()) as Written;
    expect(written.sections.map((section) => section.body)).toEqual([
      'Signed ADB.',
      'Waiting on legal.',
      null,
      null,
    ]);

    const read = await app.send('GET', `/api/clients/meeting-reports/${drafted.id}`, associate);
    expect(((await read.json()) as Written).sections).toEqual(written.sections);
  });

  it('refuse a section the report does not have', async () => {
    const drafted = await draft();

    const response = await write(drafted.id, { RISKS: 'None.' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'InvalidMeetingReport',
      field: 'sections.RISKS',
    });
  });

  it('keep the headings the report was started with', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_meeting_report (author_id, period_from, period_to, figures, sections)
       VALUES ($1, '2026-10-01', '2026-10-20', $2, $3) RETURNING id`,
      [
        people.officer,
        JSON.stringify({ contents: {}, tally: {} }),
        JSON.stringify([{ key: 'NOTES', heading: 'Notes', body: null }]),
      ],
    );

    const response = await write(rows[0].id, { NOTES: 'Kept as it was started.' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Written).sections).toEqual([
      { key: 'NOTES', heading: 'Notes', body: 'Kept as it was started.' },
    ]);
  });

  /* The user, 25 November 2026: none is needed to share it. */
  it('are not needed to share it, and are fixed once it is', async () => {
    const drafted = await draft();
    await write(drafted.id, { PROGRESS: 'Signed ADB.' });

    expect(
      (await app.send('POST', `/api/clients/meeting-reports/${drafted.id}/share`, associate))
        .status,
    ).toBe(200);

    const late = await write(drafted.id, { PROGRESS: 'Signed ADB and Ecobank.' });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'MeetingReportShared' });

    const read = await app.send('GET', `/api/clients/meeting-reports/${drafted.id}`, bdManager);
    expect(((await read.json()) as Written).sections[0].body).toBe('Signed ADB.');
  });

  it('are its author’s alone to write', async () => {
    const drafted = await draft();

    for (const somebody of [colleague, bdManager]) {
      expect((await write(drafted.id, { PROGRESS: 'Not mine.' }, somebody)).status).toBe(404);
    }
  });
});

/* ------------------------------------------------------------- a report as a PDF */

describe('a report as a PDF', () => {
  async function draftOf(as: Asker): Promise<Report> {
    const response = await app.send('POST', '/api/clients/meeting-reports', as, {});
    expect(response.status).toBe(201);

    return (await response.json()) as Report;
  }

  function pdf(id: string, as: Asker) {
    return app.send('GET', `/api/clients/meeting-reports/${id}/pdf`, as);
  }

  /* The user, 25 November 2026: drafts too, which the PDF marks as one. */
  it('downloads for its author, a draft included, named for them and its period', async () => {
    const drafted = await draftOf(associate);

    const response = await pdf(drafted.id, associate);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/pdf/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toMatch(
      new RegExp(
        `^attachment; filename="meeting-report-[a-z0-9-]+-${ROLE_BEGAN}-to-${TODAY}\\.pdf"$`,
      ),
    );

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('downloads for a BD manager once shared, and for nobody else', async () => {
    const drafted = await draftOf(associate);

    expect((await pdf(drafted.id, bdManager)).status).toBe(404);

    await app.send('POST', `/api/clients/meeting-reports/${drafted.id}/share`, associate);

    expect((await pdf(drafted.id, bdManager)).status).toBe(200);
    expect((await pdf(drafted.id, colleague)).status).toBe(404);
    expect((await pdf(drafted.id, nobody)).status).toBe(404);
  });
});
