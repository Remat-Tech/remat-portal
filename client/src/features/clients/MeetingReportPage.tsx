import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  changeMeetingReport,
  discardMeetingReport,
  downloadMeetingReportPdf,
  isNotSignedIn,
  meetingReport,
  shareMeetingReport,
  type MeetingReportView,
  type ReportContents,
  type ReportStep,
  type ReportTally,
  updateMeetingReportFigures,
  writeMeetingReportSections,
} from '../../api';
import { day, moment, period } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { LOGGED } from './Activity';
import { STAGE_NAME } from './Deals';
import { PeriodDialog } from './MeetingReports';
import { HEALTH_NAME, HealthPill } from './PocsView';
import { Count, Tile, Tiles } from './Tiles';
import { ConfirmDialog, SectionsDialog, todayInAccra, WrittenSections } from './ReportParts';

const STATUS_NAME: Record<MeetingReportView['status'], string> = {
  DRAFT: 'Draft',
  SHARED: 'Shared',
  DISCARDED: 'Discarded',
};

/**
 * A meeting report's page, at `#/clients/report/{id}`. #291, Clients SRS CLI 79 to CLI 82.
 *
 * Counts on top, then a short list under each heading (the user, 25 November 2026): the
 * activities its author logged in the period, the stage changes on deals they own, the next steps
 * they closed and those overdue at its end, and the POCs they lead with their health.
 *
 * All as saved with the report, when the draft was started or its author last updated them, so
 * nothing changed afterwards changes what it says. Its author may change a draft's period, which
 * saves the figures afresh, or discard it, or share it, which fixes it and lets every BD manager
 * read it (the user, 25 November 2026). Whoever may open it may download it as a PDF, a draft
 * marked as one.
 */
export function MeetingReportPage({ id, onSignedOut }: { id: string; onSignedOut: () => void }) {
  const [report, setReport] = useState<MeetingReportView | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [updating, setUpdating] = useState(false);
  const [open, setOpen] = useState<'period' | 'discard' | 'share' | 'sections' | undefined>(
    undefined,
  );

  const load = useCallback(() => {
    meetingReport(id)
      .then((found) => {
        setReport(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [id, onSignedOut]);

  useEffect(load, [load]);

  const [downloading, setDownloading] = useState(false);

  const download = () => {
    setDownloading(true);
    downloadMeetingReportPdf(id)
      .then(() => {
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setDownloading(false);
      });
  };

  const update = () => {
    setUpdating(true);
    updateMeetingReportFigures(id)
      .then((found) => {
        setReport(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setUpdating(false);
      });
  };

  return (
    <section className="clients-client clients-report">
      <a className="clients-back" href="#/clients">
        <Icon name="back" />
        My pipeline
      </a>

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {report === undefined ? null : (
        <>
          <header className="clients-client-head">
            <div>
              <span className="tag">Meeting report</span>
              <div className="clients-client-title">
                <h2>{period(report.period.from, report.period.to)}</h2>
              </div>
              <p className="clients-poc-sub">
                {report.author.name} ·{' '}
                {report.sharedAt !== null
                  ? `shared ${moment(report.sharedAt)}`
                  : report.discardedAt !== null
                    ? `discarded ${moment(report.discardedAt)}`
                    : `started ${moment(report.createdAt)}`}
              </p>
            </div>
            <div className="clients-client-pills">
              <span className="clients-stage-chip">{STATUS_NAME[report.status]}</span>
            </div>
          </header>

          <p className="clients-report-asof">
            <span className="muted">Figures as of {moment(report.figuresAt)}</span>
            <button type="button" disabled={downloading} onClick={download}>
              {downloading ? 'Preparing…' : 'Download PDF'}
            </button>
            {report.may.change ? (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={updating}
                  onClick={() => {
                    setOpen('share');
                  }}
                >
                  Share
                </button>
                <button type="button" disabled={updating} onClick={update}>
                  {updating ? 'Updating…' : 'Update figures'}
                </button>
                <button
                  type="button"
                  disabled={updating}
                  onClick={() => {
                    setOpen('period');
                  }}
                >
                  Change period
                </button>
                <button
                  type="button"
                  className="linkish is-danger"
                  disabled={updating}
                  onClick={() => {
                    setOpen('discard');
                  }}
                >
                  Discard draft
                </button>
              </>
            ) : null}
          </p>

          {open === 'period' ? (
            <PeriodDialog
              title="Change the period"
              intro="The days it covers. Its figures are saved afresh for them."
              initial={report.period}
              latest={todayInAccra()}
              doing="Saving…"
              done="Save"
              save={(period) =>
                changeMeetingReport(id, period).then((changed) => {
                  setReport(changed);
                  setOpen(undefined);
                })
              }
              onClose={() => {
                setOpen(undefined);
              }}
              onSignedOut={onSignedOut}
            />
          ) : open === 'sections' ? (
            <SectionsDialog
              sections={report.sections}
              save={(words) =>
                writeMeetingReportSections(id, words).then((written) => {
                  setReport(written);
                  setOpen(undefined);
                })
              }
              onClose={() => {
                setOpen(undefined);
              }}
              onSignedOut={onSignedOut}
            />
          ) : open === 'share' ? (
            /* Sharing, once asked: the figures are saved a last time and it is fixed, and every BD
               manager may read it and is emailed (the user, 25 November 2026). */
            <ConfirmDialog
              title="Share this report?"
              intro="Its figures are saved as they stand now, and it can't be changed after. The BD managers can then read it, and each gets an email."
              doing="Sharing…"
              done="Share"
              run={() =>
                shareMeetingReport(id).then((shared) => {
                  setReport(shared);
                  setOpen(undefined);
                })
              }
              onClose={() => {
                setOpen(undefined);
              }}
              onSignedOut={onSignedOut}
            />
          ) : open === 'discard' ? (
            <ConfirmDialog
              title="Discard this draft?"
              intro="It leaves your reports, and you can start another. It is kept on record."
              doing="Discarding…"
              done="Discard"
              run={() =>
                discardMeetingReport(id).then(() => {
                  window.location.hash = '#/clients';
                })
              }
              onClose={() => {
                setOpen(undefined);
              }}
              onSignedOut={onSignedOut}
            />
          ) : null}

          <ReportTiles tally={report.tally} />
          <ReportSections contents={report.contents} authorId={report.author.id} />
          <WrittenSections
            sections={report.sections}
            onWrite={
              report.may.change
                ? () => {
                    setOpen('sections');
                  }
                : undefined
            }
          />
        </>
      )}
    </section>
  );
}

function ReportTiles({ tally }: { tally: ReportTally }) {
  const kinds = tally.activities
    .filter((one) => one.count > 0)
    .map((one) => `${String(one.count)} ${LOGGED[one.kind].name.toLowerCase()}`)
    .join(' · ');
  const healths = (['STALLED', 'AT_RISK', 'ON_TRACK'] as const)
    .filter((health) => tally.pocs[health] > 0)
    .map((health) => `${String(tally.pocs[health])} ${HEALTH_NAME[health]}`)
    .join(' · ');

  return (
    <Tiles>
      <Tile label="Activities" under={kinds === '' ? null : <small>{kinds}</small>}>
        <Count of={tally.activitiesTotal} />
      </Tile>
      <Tile label="Stage changes">
        <Count of={tally.stageMoves} />
      </Tile>
      <Tile label="Steps done">
        <Count of={tally.stepsDone} />
      </Tile>
      <Tile label="Steps overdue">
        <Count of={tally.stepsOverdue} />
      </Tile>
      <Tile label="POCs" under={healths === '' ? null : <small>{healths}</small>}>
        <Count of={tally.pocsTotal} />
      </Tile>
    </Tiles>
  );
}

function ReportSections({ contents, authorId }: { contents: ReportContents; authorId: string }) {
  return (
    <div className="clients-report-sections">
      <Section title="Activities" count={contents.activities.length}>
        {contents.activities.map((activity) => (
          <li key={activity.id}>
            <span className="clients-report-when">{day(activity.happenedOn)}</span>
            <span>
              <strong>{LOGGED[activity.kind].name}</strong> with{' '}
              <ClientLink client={activity.client} />
              {activity.deal === null ? null : ` · ${activity.deal.product}`}
              {activity.outcome === null ? null : <small>{activity.outcome}</small>}
            </span>
          </li>
        ))}
      </Section>

      <Section title="Stage changes" count={contents.stageMoves.length}>
        {contents.stageMoves.map((move) => (
          <li key={move.id}>
            <span className="clients-report-when">{day(move.movedOn)}</span>
            <span>
              <ClientLink client={move.client} /> · {move.deal.product}:{' '}
              <strong>
                {move.from === null
                  ? `new deal at ${STAGE_NAME[move.to]}`
                  : move.outcome === 'LOST'
                    ? `lost at ${STAGE_NAME[move.to]}`
                    : move.outcome === 'EXITED'
                      ? 'exited'
                      : `${STAGE_NAME[move.from]} → ${STAGE_NAME[move.to]}`}
              </strong>
              {move.by.id === authorId ? null : <small>by {move.by.name}</small>}
            </span>
          </li>
        ))}
      </Section>

      <Section title="Steps done" count={contents.stepsDone.length}>
        {contents.stepsDone.map((step) => (
          <StepLine key={step.id} step={step} when={`done ${day(step.doneOn ?? step.dueOn)}`} />
        ))}
      </Section>

      <Section title="Steps overdue at the end" count={contents.stepsOverdue.length}>
        {contents.stepsOverdue.map((step) => (
          <StepLine key={step.id} step={step} when={`due ${day(step.dueOn)}`} overdue />
        ))}
      </Section>

      <Section title="POCs" count={contents.pocs.length}>
        {contents.pocs.map((poc) => (
          <li key={poc.id}>
            <span className="clients-report-when">
              <HealthPill health={poc.healthAtEnd} />
            </span>
            <span>
              <a href={`#/clients/poc/${poc.id}`}>{poc.client.name}</a> · {poc.line}
              {poc.ended === null
                ? ` · decision ${day(poc.decisionOn)}`
                : ` · ${poc.ended.outcome === 'WON' ? 'converted' : 'exited'} ${day(poc.ended.on)}`}
              {poc.changes.length === 0 ? null : (
                <small>
                  {poc.changes
                    .map((change) => `${HEALTH_NAME[change.health]} ${day(change.setOn)}`)
                    .join(' · ')}
                </small>
              )}
            </span>
          </li>
        ))}
      </Section>
    </div>
  );
}

/** A heading with its count, and its lines, or a word that there were none. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="clients-panel clients-report-section">
      <header className="clients-panel-head">
        <h3>
          {title} <span className="muted">{count}</span>
        </h3>
      </header>
      {count === 0 ? (
        <p className="muted clients-reports-none">None in this period.</p>
      ) : (
        <ul className="clients-report-lines">{children}</ul>
      )}
    </section>
  );
}

function StepLine({
  step,
  when,
  overdue = false,
}: {
  step: ReportStep;
  when: string;
  overdue?: boolean;
}) {
  return (
    <li>
      <span className={`clients-report-when${overdue ? ' is-overdue' : ''}`}>{when}</span>
      <span>
        {step.description}
        <small>
          <ClientLink client={step.client} />
          {step.deal === null ? null : ` · ${step.deal.product}`}
        </small>
      </span>
    </li>
  );
}

function ClientLink({ client }: { client: { id: string; name: string } }) {
  return <a href={`#/clients/client/${client.id}`}>{client.name}</a>;
}
