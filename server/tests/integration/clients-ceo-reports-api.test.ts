import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { freshSections, tallyOf } from '../../src/apps/clients/meeting-report.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { pinCurrentDate } from '../../src/core/calendar/time.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * CEO reports over HTTP, against a real database. #292, Clients SRS CLI 83.
 *
 * Today is {@link PINNED_DATE}, 30 October 2026, so a first report is offered 1 to 30 October.
 * The seed names Kwame (`people.ceo`) as the Chief Executive; he holds no clients role.
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;

let bdManager: Asker;
let otherBdManager: Asker;
let associate: Asker;
let colleague: Asker;
let ceo: Asker;
let nobody: Asker;

const TODAY = PINNED_DATE;
const MONTH_BEGAN = '2026-10-01';

interface Ceo {
  id: string;
  author: { id: string; name: string };
  period: { from: string; to: string };
  status: string;
  submittedAt: string | null;
  submittedTo: { id: string; name: string } | null;
  team: { author: { id: string }; reports: number; activities: number; stepsOverdue: number }[];
  totals: { reports: number; activities: number; stageMoves: number; stepsOverdue: number };
  words: { reportId: string; author: { id: string }; sections: { body: string | null }[] }[];
  pipeline: {
    recorded: { amountMinor: number; currency: string }[];
    opportunities: number;
    clients: number;
    stages: { stage: string; opportunities: number }[];
    pocsTotal: number;
  };
  sections: { key: string; heading: string; body: string | null }[];
  figuresAt: string;
  may: { change: boolean };
}

interface Listed {
  mine: { reports: Ceo[]; draftId: string | null; nextPeriod: { from: string; to: string } } | null;
  received: Ceo[] | null;
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
  await grants.grant(people.financeManager, 'BD_MANAGER', people.headOfHr, 'them');
  await grants.grant(people.officer, 'ASSOCIATE', people.headOfHr, 'them');
  await grants.grant(people.teamLead, 'ASSOCIATE', people.headOfHr, 'them');

  bdManager = { employeeId: people.commercialDirector };
  otherBdManager = { employeeId: people.financeManager };
  associate = { employeeId: people.officer };
  colleague = { employeeId: people.teamLead };
  ceo = { employeeId: people.ceo };
  nobody = { employeeId: people.engineer };

  await admin.query(`DELETE FROM email_outbox WHERE kind = 'CLIENTS_CEO_REPORT'`);
  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

/* ------------------------------------------------------------------------------ helpers */

async function list(as: Asker): Promise<Listed> {
  const response = await app.send('GET', '/api/clients/ceo-reports', as);
  expect(response.status).toBe(200);

  return (await response.json()) as Listed;
}

async function draft(as: Asker = bdManager, period: object = {}): Promise<Ceo> {
  const response = await app.send('POST', '/api/clients/ceo-reports', as, period);
  expect(response.status).toBe(201);

  return (await response.json()) as Ceo;
}

function send(method: string, path: string, as: Asker = bdManager, body?: unknown) {
  return app.send(method, `/api/clients/ceo-reports${path}`, as, body);
}

async function read(id: string, as: Asker = bdManager): Promise<Ceo> {
  const response = await send('GET', `/${id}`, as);
  expect(response.status).toBe(200);

  return (await response.json()) as Ceo;
}

/**
 * A meeting report shared at a moment, written straight to the table with a tally of `activities`
 * calls, `overdue` steps overdue, and what its author wrote in its first section.
 */
async function aSharedMeetingReport(
  author: string,
  sharedAt: string,
  shape: { activities?: number; overdue?: number; words?: string | null } = {},
): Promise<string> {
  const contents = {
    activities: Array.from({ length: shape.activities ?? 0 }, (_, index) => ({
      id: String(index),
      happenedOn: '2026-10-05',
      kind: 'CALL' as const,
      client: { id: '1', name: 'Ecobank' },
      deal: null,
      withWhom: null,
      outcome: null,
    })),
    stageMoves: [],
    stepsDone: [],
    stepsOverdue: Array.from({ length: shape.overdue ?? 0 }, (_, index) => ({
      id: String(index),
      description: 'Send the pricing',
      client: { id: '1', name: 'Ecobank' },
      deal: null,
      dueOn: '2026-10-05',
      doneOn: null,
    })),
    pocs: [],
  };
  const sections = freshSections().map((section, index) =>
    index === 0 ? { ...section, body: shape.words ?? null } : section,
  );

  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO clients_meeting_report
            (author_id, period_from, period_to, status, shared_at, figures, sections)
     VALUES ($1, '2026-10-01', '2026-10-14', 'SHARED', $2, $3, $4) RETURNING id`,
    [
      author,
      sharedAt,
      JSON.stringify({ contents, tally: tallyOf(contents) }),
      JSON.stringify(sections),
    ],
  );
  return rows[0].id;
}

/** An open deal with a value, for the pipeline. */
async function anOpenDeal(name: string, valueMinor: number | null) {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO clients_client (name, type_id, owner_id)
     SELECT $1, id, $2::bigint FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
    [name, people.officer],
  );
  await admin.query(
    `INSERT INTO clients_opportunity (client_id, product_id, owner_id, value_minor, currency)
     SELECT $1, id, $2, $3::bigint, CASE WHEN $3::bigint IS NULL THEN NULL ELSE 'GHS' END
       FROM clients_product WHERE name = 'CreditStudio'`,
    [rows[0].id, people.officer, valueMinor],
  );
}

async function emails() {
  return (
    await admin.query<{
      recipient_employee_id: string;
      subject: string;
      text_body: string;
      dedupe_key: string;
    }>(
      `SELECT recipient_employee_id, subject, text_body, dedupe_key
         FROM email_outbox WHERE kind = 'CLIENTS_CEO_REPORT' ORDER BY id`,
    )
  ).rows;
}

/* -------------------------------------------------------------- task 1: drafting a report */

describe('a BD manager drafting a CEO report', () => {
  it('is offered the 1st of the month to today, for a first one', async () => {
    expect(await list(bdManager)).toEqual({
      mine: { reports: [], draftId: null, nextPeriod: { from: MONTH_BEGAN, to: TODAY } },
      received: null,
    });
  });

  it('is offered the day after the one they submitted last', async () => {
    const first = await draft(bdManager, { from: '2026-10-01', to: '2026-10-15' });
    expect((await send('POST', `/${first.id}/submit`)).status).toBe(200);

    expect((await list(bdManager)).mine?.nextPeriod).toEqual({ from: '2026-10-16', to: TODAY });
    /* Nobody else's is moved by it. */
    expect((await list(otherBdManager)).mine?.nextPeriod).toEqual({ from: MONTH_BEGAN, to: TODAY });
  });

  it('drafts one for the period offered, or asked for', async () => {
    const drafted = await draft();
    expect(drafted).toMatchObject({
      author: { id: people.commercialDirector },
      period: { from: MONTH_BEGAN, to: TODAY },
      status: 'DRAFT',
      may: { change: true },
    });
    expect((await list(bdManager)).mine?.draftId).toBe(drafted.id);

    expect((await draft(otherBdManager, { from: '2026-10-10', to: '2026-10-20' })).period).toEqual({
      from: '2026-10-10',
      to: '2026-10-20',
    });
  });

  it('refuses a period ending after today, or starting after it ends', async () => {
    const later = await send('POST', '', bdManager, { to: '2026-10-31' });
    expect(later.status).toBe(400);
    expect(await later.json()).toMatchObject({ error: 'InvalidCeoReport', field: 'to' });

    const backwards = await send('POST', '', bdManager, { from: '2026-10-20', to: '2026-10-19' });
    expect(backwards.status).toBe(400);
    expect(await backwards.json()).toMatchObject({ field: 'from' });
  });

  it('keeps each BD manager to one draft at a time', async () => {
    await draft();

    const second = await send('POST', '', bdManager, {});
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'CeoReportDraftOpen' });

    await draft(otherBdManager);
  });

  it('is a BD manager’s alone', async () => {
    expect((await send('POST', '', associate, {})).status).toBe(403);
    expect((await send('POST', '', nobody, {})).status).toBe(404);
    expect((await send('POST', '', ceo, {})).status).toBe(404);
  });
});

/* ------------------------------------------------------------- task 2: what it is built from */

describe('what a CEO report is built from', () => {
  it('takes the meeting reports shared during its period, and what their authors wrote', async () => {
    const early = await aSharedMeetingReport(people.officer, '2026-10-05T09:00:00Z', {
      activities: 3,
      overdue: 1,
      words: 'Signed Ecobank.',
    });
    const lastDay = await aSharedMeetingReport(people.officer, `${TODAY}T23:30:00Z`, {
      activities: 2,
    });
    const colleagues = await aSharedMeetingReport(people.teamLead, '2026-10-12T09:00:00Z', {
      activities: 4,
      overdue: 2,
    });
    /* Shared before the period, and a draft: neither is in it. */
    await aSharedMeetingReport(people.officer, '2026-09-30T23:30:00Z', { activities: 9 });
    await admin.query(
      `INSERT INTO clients_meeting_report (author_id, period_from, period_to, figures)
       VALUES ($1, '2026-10-01', '2026-10-14', '{}')`,
      [people.teamLead],
    );

    const report = await draft();

    expect(report.totals).toMatchObject({ reports: 3, activities: 9, stepsOverdue: 3 });
    const rows = report.team
      .map((row) => [row.author.id, row.reports, row.activities, row.stepsOverdue])
      .sort((one, other) => String(one[0]).localeCompare(String(other[0])));
    expect(rows).toEqual(
      [
        [people.teamLead, 1, 4, 2],
        [people.officer, 2, 5, 1],
      ].sort((one, other) => String(one[0]).localeCompare(String(other[0]))),
    );
    expect(report.words.map((one) => one.reportId)).toEqual([early, colleagues, lastDay]);
    expect(report.words[0].sections[0].body).toBe('Signed Ecobank.');
  });

  it('takes the pipeline as it stands', async () => {
    await anOpenDeal('Ecobank', 1_000_000);
    await anOpenDeal('ADB', 250_000);
    await anOpenDeal('GCB', null);

    const report = await draft();

    expect(report.pipeline).toMatchObject({
      recorded: [{ amountMinor: 1_250_000, currency: 'GHS' }],
      opportunities: 3,
      clients: 3,
      pocsTotal: 0,
    });
    expect(report.pipeline.stages.find((one) => one.stage === 'DISCOVERY')?.opportunities).toBe(3);
  });

  it('starts with the BD manager’s four placeholder sections, empty', async () => {
    expect((await draft()).sections).toEqual([
      { key: 'HIGHLIGHTS', heading: 'Highlights', body: null },
      { key: 'RISKS', heading: 'Risks and where I need support', body: null },
      { key: 'OUTLOOK', heading: 'Outlook for the next period', body: null },
      { key: 'OTHER', heading: 'Anything else', body: null },
    ]);
  });
});

/* --------------------------------------------------------------- task 3: saved figures */

describe('the figures saved with a CEO report', () => {
  it('are kept as they were, and saved afresh when its author asks', async () => {
    await aSharedMeetingReport(people.officer, '2026-10-05T09:00:00Z', { activities: 3 });
    const drafted = await draft();

    await aSharedMeetingReport(people.teamLead, '2026-10-06T09:00:00Z', { activities: 4 });
    await anOpenDeal('Ecobank', 1_000_000);

    const later = await read(drafted.id);
    expect(later.totals.activities).toBe(3);
    expect(later.pipeline.opportunities).toBe(0);
    expect(later.figuresAt).toBe(drafted.figuresAt);

    const response = await send('POST', `/${drafted.id}/figures`);
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Ceo;
    expect(updated.totals.activities).toBe(7);
    expect(updated.pipeline.opportunities).toBe(1);
  });
});

/* ------------------------------------------------------- task 4: editable until submitted */

describe('changing a CEO report', () => {
  it('takes a new period, saving its figures for it', async () => {
    await aSharedMeetingReport(people.officer, '2026-10-05T09:00:00Z', { activities: 3 });
    const drafted = await draft(bdManager, { from: '2026-10-10' });
    expect(drafted.totals.reports).toBe(0);

    const response = await send('PATCH', `/${drafted.id}`, bdManager, { from: '2026-10-01' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Ceo).totals.reports).toBe(1);
  });

  it('takes the BD manager’s words, those left out kept', async () => {
    const drafted = await draft();

    await send('PATCH', `/${drafted.id}/sections`, bdManager, {
      sections: { HIGHLIGHTS: 'Fidelity signed.', RISKS: 'ADB pricing.' },
    });
    const response = await send('PATCH', `/${drafted.id}/sections`, bdManager, {
      sections: { RISKS: null },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Ceo).sections.map((one) => one.body)).toEqual([
      'Fidelity signed.',
      null,
      null,
      null,
    ]);

    const unknown = await send('PATCH', `/${drafted.id}/sections`, bdManager, {
      sections: { PROGRESS: 'x' },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({
      error: 'InvalidCeoReport',
      field: 'sections.PROGRESS',
    });
  });

  it('is discarded and kept, which frees its author to start another', async () => {
    const drafted = await draft();

    const response = await send('POST', `/${drafted.id}/discard`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'DISCARDED', may: { change: false } });
    expect(await list(bdManager)).toMatchObject({ mine: { reports: [], draftId: null } });
    await draft();
  });

  it('is its author’s alone', async () => {
    const drafted = await draft();

    for (const somebody of [otherBdManager, associate, ceo]) {
      expect((await send('PATCH', `/${drafted.id}`, somebody, { from: '2026-10-02' })).status).toBe(
        404,
      );
      expect((await send('POST', `/${drafted.id}/submit`, somebody)).status).toBe(404);
    }
  });

  it('is fixed once submitted, for everybody', async () => {
    const drafted = await draft();
    expect((await send('POST', `/${drafted.id}/submit`)).status).toBe(200);

    for (const response of [
      await send('PATCH', `/${drafted.id}`, bdManager, { from: '2026-10-02' }),
      await send('PATCH', `/${drafted.id}/sections`, bdManager, { sections: { OTHER: 'x' } }),
      await send('POST', `/${drafted.id}/figures`),
      await send('POST', `/${drafted.id}/discard`),
      await send('POST', `/${drafted.id}/submit`),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'CeoReportSubmitted' });
    }

    /* The Chief Executive may read it, not change it. */
    expect((await send('POST', `/${drafted.id}/figures`, ceo)).status).toBe(403);
  });
});

/* ------------------------------------------------------- task 5: submitting to the CEO */

describe('submitting a CEO report', () => {
  it('saves its figures a last time, fixes it, and emails the Chief Executive once', async () => {
    const drafted = await draft();
    await aSharedMeetingReport(people.officer, '2026-10-05T09:00:00Z', { activities: 3 });

    const response = await send('POST', `/${drafted.id}/submit`);
    expect(response.status).toBe(200);
    const submitted = (await response.json()) as Ceo;
    expect(submitted).toMatchObject({
      status: 'SUBMITTED',
      submittedTo: { id: people.ceo },
      may: { change: false },
    });
    expect(submitted.totals.activities).toBe(3);

    const sent = await emails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      recipient_employee_id: people.ceo,
      dedupe_key: `CLIENTS_CEO_REPORT:${drafted.id}`,
    });
    expect(sent[0].subject).toMatch(/^Report to the CEO from /);
    expect(sent[0].text_body).toContain(`http://portal.test/#/clients/ceo-report/${drafted.id}`);
  });

  it('is refused with nobody named as the Chief Executive, and stays a draft', async () => {
    /* The database keeps somebody named; a database nobody has set up yet has nobody. */
    await admin.query('ALTER TABLE organisation_setting DISABLE TRIGGER USER');
    await admin.query('UPDATE organisation_setting SET ceo_employee_id = NULL');
    await admin.query('ALTER TABLE organisation_setting ENABLE TRIGGER USER');
    const drafted = await draft();

    const response = await send('POST', `/${drafted.id}/submit`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'NoChiefExecutive' });
    expect((await read(drafted.id)).status).toBe('DRAFT');
    expect(await emails()).toEqual([]);
  });

  /* #292: nothing is ever sent without the BD manager choosing to. */
  it('is the only thing that sends anything', async () => {
    const drafted = await draft();
    await send('PATCH', `/${drafted.id}`, bdManager, { from: '2026-10-02' });
    await send('PATCH', `/${drafted.id}/sections`, bdManager, { sections: { OTHER: 'x' } });
    await send('POST', `/${drafted.id}/figures`);
    await send('GET', `/${drafted.id}/pdf`);
    await send('POST', `/${drafted.id}/discard`);
    await draft();

    expect(await emails()).toEqual([]);
  });
});

/* ------------------------------------------------- the Chief Executive, and who sees what */

describe('the Chief Executive', () => {
  it('sees the tile and the CEO reports, and nothing else in clients', async () => {
    const apps = await app.send('GET', '/api/me/apps', ceo);
    expect(await apps.json()).toEqual({ apps: expect.arrayContaining(['clients']) as string[] });

    const me = await app.send('GET', '/api/clients/me', ceo);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      readCeoReports: true,
      draftCeoReports: false,
      pocs: false,
      setUp: false,
    });

    for (const path of [
      '/api/clients/pipeline',
      '/api/clients/dashboard',
      '/api/clients/meeting-reports',
    ]) {
      expect((await app.send('GET', path, ceo)).status).toBe(404);
    }
    expect(await list(ceo)).toEqual({ mine: null, received: [] });
  });

  /* #292, done when: the CEO receives it. */
  it('receives every submitted report, and no draft', async () => {
    const theirs = await draft();
    await send('POST', `/${theirs.id}/submit`);
    const others = await draft(otherBdManager);
    await send('POST', `/${others.id}/submit`, otherBdManager);
    const stillDrafting = await draft();

    expect((await list(ceo)).received?.map((one) => one.id).sort()).toEqual(
      [theirs.id, others.id].sort(),
    );
    expect((await read(theirs.id, ceo)).status).toBe('SUBMITTED');
    expect((await read(theirs.id, ceo)).may.change).toBe(false);

    const draftByLink = await send('GET', `/${stillDrafting.id}`, ceo);
    expect(draftByLink.status).toBe(404);
  });

  it('stops being shown them when somebody else is named', async () => {
    const drafted = await draft();
    await send('POST', `/${drafted.id}/submit`);
    await admin.query('UPDATE organisation_setting SET ceo_employee_id = $1', [people.opsDirector]);

    expect((await send('GET', `/${drafted.id}`, ceo)).status).toBe(404);
    expect((await read(drafted.id, { employeeId: people.opsDirector })).status).toBe('SUBMITTED');
  });
});

describe('who can see a CEO report', () => {
  it('is its author’s, and the Chief Executive’s once submitted, by list and by link', async () => {
    const drafted = await draft();
    const missing = await (await send('GET', '/987654321', otherBdManager)).json();

    for (const somebody of [otherBdManager, associate, colleague]) {
      const byLink = await send('GET', `/${drafted.id}`, somebody);
      expect(byLink.status).toBe(404);
      expect(await byLink.json()).toEqual(missing);
    }
    expect((await list(otherBdManager)).mine?.reports).toEqual([]);
    expect((await send('GET', `/${drafted.id}`, nobody)).status).toBe(404);

    denials.clear();
    await send('GET', `/${drafted.id}`, otherBdManager);
    expect(denials.last()).toMatchObject({ action: 'readCeoReport', subject: drafted.id });
  });

  it('downloads as a PDF for whoever may read it', async () => {
    const drafted = await draft();

    const pdf = await send('GET', `/${drafted.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toMatch(/^application\/pdf/);
    expect(pdf.headers.get('content-disposition')).toMatch(
      /^attachment; filename="report-to-the-ceo-[a-z0-9-]+-2026-10-01-to-2026-10-30\.pdf"$/,
    );
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');

    expect((await send('GET', `/${drafted.id}/pdf`, ceo)).status).toBe(404);
    await send('POST', `/${drafted.id}/submit`);
    expect((await send('GET', `/${drafted.id}/pdf`, ceo)).status).toBe(200);
    expect((await send('GET', `/${drafted.id}/pdf`, otherBdManager)).status).toBe(404);
  });
});

/* #292, done when: the BD manager can produce and submit it from the team's shared reports. */
describe('from the team’s shared reports to the CEO', () => {
  /* Through the API end to end, so the meeting report is shared today, the real one: the pin
     is let go for it, as a file testing the database's own clock does. */
  beforeEach(() => {
    pinCurrentDate(null);
  });
  afterAll(() => {
    pinCurrentDate(PINNED_DATE);
  });

  it('goes from shared meeting reports to a submitted report the CEO reads', async () => {
    const shared = await app.send('POST', '/api/clients/meeting-reports', associate, {});
    expect(shared.status).toBe(201);
    const meeting = (await shared.json()) as { id: string };
    await app.send('PATCH', `/api/clients/meeting-reports/${meeting.id}/sections`, associate, {
      sections: { PROGRESS: 'Ecobank qualified.' },
    });
    expect(
      (await app.send('POST', `/api/clients/meeting-reports/${meeting.id}/share`, associate))
        .status,
    ).toBe(200);

    const drafted = await draft();
    expect(drafted.words.map((one) => one.reportId)).toEqual([meeting.id]);
    await send('PATCH', `/${drafted.id}/sections`, bdManager, {
      sections: { HIGHLIGHTS: 'Ecobank is moving.' },
    });
    expect((await send('POST', `/${drafted.id}/submit`)).status).toBe(200);

    const received = await read(drafted.id, ceo);
    expect(received.words[0].sections[0].body).toBe('Ecobank qualified.');
    expect(received.sections[0].body).toBe('Ecobank is moving.');
  });
});
