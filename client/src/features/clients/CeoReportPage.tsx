import { useCallback, useEffect, useState } from 'react';
import {
  ceoReport,
  type CeoReportView,
  changeCeoReport,
  discardCeoReport,
  downloadCeoReportPdf,
  isNotSignedIn,
  submitCeoReport,
  updateCeoReportFigures,
  writeCeoReportSections,
} from '../../api';
import { moment, period } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { STAGE_NAME } from './Deals';
import { PeriodDialog } from './MeetingReports';
import { HEALTH_NAME } from './PocsView';
import { ConfirmDialog, SectionsDialog, todayInAccra, WrittenSections } from './ReportParts';
import { Count, MoneyLines, Tile, Tiles } from './Tiles';

const STATUS_NAME: Record<CeoReportView['status'], string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  DISCARDED: 'Discarded',
};

/**
 * A CEO report's page, at `#/clients/ceo-report/{id}`. #292, Clients SRS CLI 83.
 *
 * As saved with the report: the team's numbers, the pipeline as it stood, a row per associate,
 * what the BD manager wrote, and what each associate wrote in the reports they shared. Its author
 * may update the figures, change the period, write their sections, discard it, or submit it to
 * the Chief Executive, which fixes it and is the only thing that sends anything (#292). The Chief
 * Executive reads it here once submitted. Whoever may open it may download it as a PDF.
 */
export function CeoReportPage({
  id,
  back,
  onSignedOut,
}: {
  id: string;
  /** Where "back" goes: My pipeline for a BD manager, the received list for the CEO. */
  back: { href: string; label: string };
  onSignedOut: () => void;
}) {
  const [report, setReport] = useState<CeoReportView | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [busy, setBusy] = useState<'figures' | 'pdf' | undefined>(undefined);
  const [open, setOpen] = useState<'period' | 'sections' | 'submit' | 'discard' | undefined>(
    undefined,
  );

  const failed = useCallback(
    (error: unknown) => {
      if (isNotSignedIn(error)) {
        onSignedOut();
        return;
      }
      setProblem(problemFrom(error));
    },
    [onSignedOut],
  );

  const load = useCallback(() => {
    ceoReport(id)
      .then((found) => {
        setReport(found);
        setProblem(undefined);
      })
      .catch(failed);
  }, [id, failed]);

  useEffect(load, [load]);

  const run = (what: 'figures' | 'pdf') => {
    setBusy(what);
    (what === 'pdf'
      ? downloadCeoReportPdf(id)
      : updateCeoReportFigures(id).then((found) => {
          setReport(found);
        })
    )
      .then(() => {
        setProblem(undefined);
      })
      .catch(failed)
      .finally(() => {
        setBusy(undefined);
      });
  };

  const close = () => {
    setOpen(undefined);
  };
  const saved = (found: CeoReportView) => {
    setReport(found);
    setOpen(undefined);
  };

  return (
    <section className="clients-client clients-report">
      <a className="clients-back" href={back.href}>
        <Icon name="back" />
        {back.label}
      </a>

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {report === undefined ? null : (
        <>
          <header className="clients-client-head">
            <div>
              <span className="tag">Report to the CEO</span>
              <div className="clients-client-title">
                <h2>{period(report.period.from, report.period.to)}</h2>
              </div>
              <p className="clients-poc-sub">
                {report.author.name} ·{' '}
                {report.submittedAt !== null
                  ? `submitted ${moment(report.submittedAt)}` +
                    (report.submittedTo === null ? '' : ` to ${report.submittedTo.name}`)
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
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => {
                run('pdf');
              }}
            >
              {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
            </button>
            {report.may.change ? (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== undefined}
                  onClick={() => {
                    setOpen('submit');
                  }}
                >
                  Submit to the CEO
                </button>
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => {
                    run('figures');
                  }}
                >
                  {busy === 'figures' ? 'Updating…' : 'Update figures'}
                </button>
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => {
                    setOpen('period');
                  }}
                >
                  Change period
                </button>
                <button
                  type="button"
                  className="linkish is-danger"
                  disabled={busy !== undefined}
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
              save={(chosen) => changeCeoReport(id, chosen).then(saved)}
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : open === 'sections' ? (
            <SectionsDialog
              sections={report.sections}
              save={(words) => writeCeoReportSections(id, words).then(saved)}
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : open === 'submit' ? (
            /* The one thing that sends anything (#292): asked first, every time. */
            <ConfirmDialog
              title="Submit this report to the CEO?"
              intro="Its figures are saved as they stand now, and it can't be changed after. The Chief Executive can then read it, and gets an email with a link."
              doing="Submitting…"
              done="Submit"
              run={() => submitCeoReport(id).then(saved)}
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : open === 'discard' ? (
            <ConfirmDialog
              title="Discard this draft?"
              intro="It leaves your CEO reports, and you can start another. It is kept on record."
              doing="Discarding…"
              done="Discard"
              run={() =>
                discardCeoReport(id).then(() => {
                  window.location.hash = '#/clients';
                })
              }
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : null}

          <CeoTiles report={report} />
          <CeoPipeline report={report} />
          <TeamTable report={report} />
          <WrittenSections
            title="From the BD manager"
            sections={report.sections}
            onWrite={
              report.may.change
                ? () => {
                    setOpen('sections');
                  }
                : undefined
            }
          />
          <AssociatesWords report={report} />
        </>
      )}
    </section>
  );
}

function CeoTiles({ report }: { report: CeoReportView }) {
  const { totals, pipeline } = report;

  return (
    <Tiles>
      <Tile label="Reports shared">
        <Count of={totals.reports} />
      </Tile>
      <Tile label="Activities">
        <Count of={totals.activities} />
      </Tile>
      <Tile label="Stage changes">
        <Count of={totals.stageMoves} />
      </Tile>
      <Tile label="Steps overdue">
        <Count of={totals.stepsOverdue} />
      </Tile>
      <Tile
        label="Recorded value"
        under={<small>{`${String(pipeline.opportunities)} open deals`}</small>}
      >
        <MoneyLines amounts={pipeline.recorded} />
      </Tile>
    </Tiles>
  );
}

/** The pipeline as it stood when the figures were saved: deals by stage, and POCs by health. */
function CeoPipeline({ report }: { report: CeoReportView }) {
  const { pipeline } = report;

  return (
    <section className="clients-panel clients-report-section">
      <header className="clients-panel-head">
        <div>
          <h3>The pipeline as it stands</h3>
          <p className="muted">
            {pipeline.opportunities} open deals · {pipeline.clients} clients
            {pipeline.noValue === 0 ? '' : ` · ${String(pipeline.noValue)} with no value`} ·{' '}
            {pipeline.pocsTotal} POCs running
          </p>
        </div>
      </header>
      <ul className="clients-report-lines">
        {pipeline.stages.map((stage) => (
          <li key={stage.stage}>
            <span className="clients-report-when">{STAGE_NAME[stage.stage]}</span>
            <span>
              <strong>{stage.opportunities}</strong> open
            </span>
          </li>
        ))}
        <li>
          <span className="clients-report-when">POC health</span>
          <span>
            {(['ON_TRACK', 'AT_RISK', 'STALLED'] as const)
              .map((health) => `${String(pipeline.pocs[health])} ${HEALTH_NAME[health]}`)
              .join(' · ')}
          </span>
        </li>
      </ul>
    </section>
  );
}

/** A row per associate, from the meeting reports they shared in the period, and the total. */
function TeamTable({ report }: { report: CeoReportView }) {
  if (report.team.length === 0) {
    return (
      <section className="clients-panel clients-report-section">
        <header className="clients-panel-head">
          <h3>The team</h3>
        </header>
        <p className="muted clients-reports-none">No meeting reports were shared in this period.</p>
      </section>
    );
  }

  const cells = (row: CeoReportView['totals']) => (
    <>
      <td data-label="Reports" className="is-figure">
        {row.reports}
      </td>
      <td data-label="Activities" className="is-figure">
        {row.activities}
      </td>
      <td data-label="Stage changes" className="is-figure">
        {row.stageMoves}
      </td>
      <td data-label="Steps done" className="is-figure">
        {row.stepsDone}
      </td>
      <td data-label="Overdue" className="is-figure">
        {row.stepsOverdue}
      </td>
      <td data-label="POCs" className="is-figure">
        {row.pocs}
      </td>
    </>
  );

  return (
    <section className="clients-panel clients-report-section">
      <header className="clients-panel-head">
        <h3>The team</h3>
      </header>
      <table className="clients-deals clients-reports-list">
        <thead>
          <tr>
            <th scope="col">Associate</th>
            <th scope="col" className="is-figure">
              Reports
            </th>
            <th scope="col" className="is-figure">
              Activities
            </th>
            <th scope="col" className="is-figure">
              Stage changes
            </th>
            <th scope="col" className="is-figure">
              Steps done
            </th>
            <th scope="col" className="is-figure">
              Overdue
            </th>
            <th scope="col" className="is-figure">
              POCs
            </th>
          </tr>
        </thead>
        <tbody>
          {report.team.map((row) => (
            <tr key={row.author.id}>
              <td>{row.author.name}</td>
              {cells(row)}
            </tr>
          ))}
          <tr className="is-total">
            <td>
              <strong>Team</strong>
            </td>
            {cells(report.totals)}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/** What each associate wrote in the meeting reports they shared in the period. */
function AssociatesWords({ report }: { report: CeoReportView }) {
  return (
    <section className="clients-panel clients-report-section clients-report-written">
      <header className="clients-panel-head">
        <h3>In the associates&rsquo; words</h3>
      </header>
      {report.words.length === 0 ? (
        <p className="muted clients-reports-none">No meeting reports were shared in this period.</p>
      ) : (
        <dl className="clients-report-written-list">
          {report.words.flatMap((shared) => {
            const written = shared.sections.filter((section) => section.body !== null);
            const whose = `${shared.author.name} · ${period(shared.period.from, shared.period.to)}`;

            return written.length === 0
              ? [
                  <div key={shared.reportId}>
                    <dt>{whose}</dt>
                    <dd className="muted">Nothing written</dd>
                  </div>,
                ]
              : written.map((section) => (
                  <div key={`${shared.reportId}-${section.key}`}>
                    <dt>
                      {shared.author.name} · {section.heading}
                    </dt>
                    <dd>{section.body}</dd>
                  </div>
                ));
          })}
        </dl>
      )}
    </section>
  );
}
