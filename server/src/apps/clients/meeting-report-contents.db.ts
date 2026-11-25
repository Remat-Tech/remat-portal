/**
 * What a meeting report is built from: one person's work in a period. #291. Read only.
 *
 * As the user chose on 25 November 2026:
 *
 * - **Activities they logged** that happened in the period.
 * - **Stage changes made in the period on deals they own**, whoever made them.
 * - **Next steps of theirs closed in the period**, and **those still open and past due at the
 *   period's end**: due before its last day, as My pipeline counts overdue against today.
 * - **Every POC they lead that ran during the period**: started by its last day and not ended
 *   before its first. Its health on the last day, and each health it was set to within.
 *
 * A moment, a stage change or a step closed, falls on the company's day, which is UTC's (Accra is
 * UTC+0 all year).
 */

import { type Kysely, sql } from 'kysely';
import type { Database } from '../../core/db/index.js';
import type { ActivityKind } from './logged-activity.js';
import type {
  Period,
  ReportActivity,
  ReportContents,
  ReportHealthChange,
  ReportPoc,
  ReportStageMove,
  ReportStep,
} from './meeting-report.js';
import type { Outcome } from './opportunity.js';
import type { PocHealth } from './poc.js';
import type { Stage } from './stage.js';

/** The company's day a moment fell on. */
const dayOf = (column: string) => sql.raw(`((${column}) AT TIME ZONE 'UTC')::date`);

const nameOf = (alias: string) => sql.raw(`${alias}.first_name || ' ' || ${alias}.last_name`);

export class ClientsReportContentsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async of(personId: string, period: Period): Promise<ReportContents> {
    const [activities, stageMoves, stepsDone, stepsOverdue, pocs] = await Promise.all([
      this.activities(personId, period),
      this.stageMoves(personId, period),
      this.stepsDone(personId, period),
      this.stepsOverdue(personId, period),
      this.pocs(personId, period),
    ]);

    return { activities, stageMoves, stepsDone, stepsOverdue, pocs };
  }

  /** Oldest first, as they happened. */
  private async activities(personId: string, { from, to }: Period): Promise<ReportActivity[]> {
    const { rows } = await sql<{
      id: string;
      happened_on: string;
      kind: string;
      client_id: string;
      client_name: string;
      deal_id: string | null;
      product: string | null;
      with_whom: string | null;
      outcome: string | null;
    }>`
      SELECT a.id, a.happened_on::text AS happened_on, a.kind,
             c.id AS client_id, c.name AS client_name,
             o.id AS deal_id, p.name AS product,
             a.with_whom, a.outcome
        FROM clients_activity a
        JOIN clients_client c ON c.id = a.client_id
        LEFT JOIN clients_opportunity o ON o.id = a.opportunity_id
        LEFT JOIN clients_product p ON p.id = o.product_id
       WHERE a.logged_by = ${personId}
         AND a.happened_on BETWEEN ${from}::date AND ${to}::date
       ORDER BY a.happened_on, a.id`.execute(this.db);

    return rows.map((row) => ({
      id: row.id,
      happenedOn: row.happened_on,
      kind: row.kind as ActivityKind,
      client: { id: row.client_id, name: row.client_name },
      deal: row.deal_id === null ? null : { id: row.deal_id, product: row.product ?? '' },
      withWhom: row.with_whom,
      outcome: row.outcome,
    }));
  }

  /** Oldest first. */
  private async stageMoves(personId: string, { from, to }: Period): Promise<ReportStageMove[]> {
    const { rows } = await sql<{
      id: string;
      moved_on: string;
      client_id: string;
      client_name: string;
      deal_id: string;
      product: string;
      from_stage: string | null;
      to_stage: string;
      to_outcome: string;
      note: string | null;
      by_id: string;
      by_name: string;
    }>`
      SELECT s.id, ${dayOf('s.changed_at')}::text AS moved_on,
             c.id AS client_id, c.name AS client_name,
             o.id AS deal_id, p.name AS product,
             s.from_stage, s.to_stage, s.to_outcome, s.note,
             e.id AS by_id, ${nameOf('e')} AS by_name
        FROM clients_stage_change s
        JOIN clients_opportunity o ON o.id = s.opportunity_id
        JOIN clients_client c ON c.id = o.client_id
        JOIN clients_product p ON p.id = o.product_id
        JOIN employee e ON e.id = s.changed_by
       WHERE o.owner_id = ${personId}
         AND ${dayOf('s.changed_at')} BETWEEN ${from}::date AND ${to}::date
       ORDER BY s.changed_at, s.id`.execute(this.db);

    return rows.map((row) => ({
      id: row.id,
      movedOn: row.moved_on,
      client: { id: row.client_id, name: row.client_name },
      deal: { id: row.deal_id, product: row.product },
      from: row.from_stage as Stage | null,
      to: row.to_stage as Stage,
      outcome: row.to_outcome as Outcome,
      note: row.note,
      by: { id: row.by_id, name: row.by_name },
    }));
  }

  /** Closed in the period, in the order they were closed. */
  private async stepsDone(personId: string, { from, to }: Period): Promise<ReportStep[]> {
    return this.steps(
      personId,
      sql`${dayOf('n.done_at')} BETWEEN ${from}::date AND ${to}::date`,
      sql`n.done_at, n.id`,
    );
  }

  /**
   * Open at the end of the period's last day and due before it: made by then, and not closed by
   * then. Longest overdue first.
   */
  private async stepsOverdue(personId: string, { to }: Period): Promise<ReportStep[]> {
    return this.steps(
      personId,
      sql`n.due_on < ${to}::date
          AND ${dayOf('n.created_at')} <= ${to}::date
          AND (n.done_at IS NULL OR ${dayOf('n.done_at')} > ${to}::date)`,
      sql`n.due_on, n.id`,
    );
  }

  private async steps(
    personId: string,
    which: ReturnType<typeof sql>,
    order: ReturnType<typeof sql>,
  ): Promise<ReportStep[]> {
    const { rows } = await sql<{
      id: string;
      description: string;
      client_id: string;
      client_name: string;
      deal_id: string | null;
      product: string | null;
      due_on: string;
      done_on: string | null;
    }>`
      SELECT n.id, n.description, c.id AS client_id, c.name AS client_name,
             o.id AS deal_id, p.name AS product, n.due_on::text AS due_on,
             ${dayOf('n.done_at')}::text AS done_on
        FROM clients_next_step n
        JOIN clients_client c ON c.id = n.client_id
        LEFT JOIN clients_opportunity o ON o.id = n.opportunity_id
        LEFT JOIN clients_product p ON p.id = o.product_id
       WHERE n.owner_id = ${personId} AND ${which}
       ORDER BY ${order}`.execute(this.db);

    return rows.map((row) => ({
      id: row.id,
      description: row.description,
      client: { id: row.client_id, name: row.client_name },
      deal: row.deal_id === null ? null : { id: row.deal_id, product: row.product ?? '' },
      dueOn: row.due_on,
      doneOn: row.done_on,
    }));
  }

  /**
   * Those they lead now that ran during the period, soonest started first. A POC ends as its one
   * deal ends (#287), so it ran in the period where it started by the last day and its deal was
   * still open, or ended on or after the first.
   */
  private async pocs(personId: string, { from, to }: Period): Promise<ReportPoc[]> {
    const { rows } = await sql<{
      id: string;
      client_id: string;
      client_name: string;
      line: string;
      started_on: string;
      decision_on: string;
      health_at_end: string;
      outcome: string;
      ended_on: string | null;
    }>`
      SELECT poc.id, c.id AS client_id, c.name AS client_name, l.name AS line,
             poc.started_on::text AS started_on, poc.decision_on::text AS decision_on,
             (SELECT h.health FROM clients_poc_health h
               WHERE h.poc_id = poc.id AND ${dayOf('h.set_at')} <= ${to}::date
               ORDER BY h.set_at DESC, h.id DESC LIMIT 1) AS health_at_end,
             o.outcome, o.ended_on::text AS ended_on
        FROM clients_poc poc
        JOIN clients_client c ON c.id = poc.client_id
        JOIN clients_product_line l ON l.id = poc.line_id
        JOIN clients_opportunity o ON o.poc_id = poc.id
       WHERE poc.cs_lead_id = ${personId}
         AND poc.started_on <= ${to}::date
         AND (o.ended_on IS NULL OR o.ended_on >= ${from}::date)
       ORDER BY poc.started_on, poc.id`.execute(this.db);

    if (rows.length === 0) {
      return [];
    }

    const changes = await sql<{
      poc_id: string;
      health: string;
      set_on: string;
      note: string | null;
      by_id: string;
      by_name: string;
    }>`
      SELECT h.poc_id, h.health, ${dayOf('h.set_at')}::text AS set_on, h.note,
             e.id AS by_id, ${nameOf('e')} AS by_name
        FROM clients_poc_health h
        JOIN employee e ON e.id = h.set_by
       WHERE h.poc_id = ANY(${rows.map((row) => row.id)}::bigint[])
         AND ${dayOf('h.set_at')} BETWEEN ${from}::date AND ${to}::date
       ORDER BY h.set_at, h.id`.execute(this.db);

    const changesOf = new Map<string, ReportHealthChange[]>();
    for (const row of changes.rows) {
      const list = changesOf.get(row.poc_id) ?? [];
      list.push({
        health: row.health as PocHealth,
        setOn: row.set_on,
        note: row.note,
        by: { id: row.by_id, name: row.by_name },
      });
      changesOf.set(row.poc_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      client: { id: row.client_id, name: row.client_name },
      line: row.line,
      startedOn: row.started_on,
      decisionOn: row.decision_on,
      healthAtEnd: row.health_at_end as PocHealth,
      changes: changesOf.get(row.id) ?? [],
      ended:
        row.ended_on !== null && row.ended_on <= to
          ? { outcome: row.outcome as Outcome, on: row.ended_on }
          : null,
    }));
  }
}
