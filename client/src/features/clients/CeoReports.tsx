import { useCallback, useEffect, useState } from 'react';
import {
  type CeoReport,
  ceoReports,
  type CeoReportsList,
  draftCeoReport,
  isNotSignedIn,
} from '../../api';
import { moment, period } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { PeriodDialog } from './MeetingReports';

/**
 * CEO reports in lists. #292, Clients SRS CLI 83.
 *
 * A BD manager's own, as a "CEO reports" section on My pipeline under the shared meeting reports:
 * a new one is offered the days since the last they submitted, or since the 1st of the month, and
 * one draft at a time opens instead of starting another. And the Chief Executive's, every report
 * submitted to them, on a page of its own: the one place in clients they have.
 */

function useCeoReports(onSignedOut: () => void) {
  const [list, setList] = useState<CeoReportsList | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const load = useCallback(() => {
    ceoReports()
      .then((found) => {
        setList(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  return { list, problem, load };
}

/** A BD manager's own CEO reports, on My pipeline. Nothing at all for anybody else. */
export function MyCeoReports({ onSignedOut }: { onSignedOut: () => void }) {
  const { list, problem, load } = useCeoReports(onSignedOut);
  const [drafting, setDrafting] = useState(false);
  const mine = list?.mine ?? null;

  if (mine === null) {
    return problem === undefined ? null : <Notice problem={problem} onRetry={load} />;
  }

  return (
    <section
      className="clients-panel clients-reports"
      aria-labelledby="clients-ceo-reports-heading"
    >
      <header className="clients-panel-head">
        <div>
          <h3 id="clients-ceo-reports-heading">CEO reports</h3>
          <p className="muted">Your report to the CEO, from the team&rsquo;s shared reports.</p>
        </div>
        {mine.draftId !== null ? (
          <a className="button-link primary" href={`#/clients/ceo-report/${mine.draftId}`}>
            Open your draft
          </a>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={() => {
              setDrafting(true);
            }}
          >
            New CEO report
          </button>
        )}
      </header>

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {mine.reports.length === 0 ? (
        <p className="muted clients-reports-none">No CEO reports yet.</p>
      ) : (
        <CeoReportList reports={mine.reports} />
      )}

      {drafting ? (
        <PeriodDialog
          title="New CEO report"
          intro="The days it covers. It starts the day after your last submitted one, or the 1st of the month. The meeting reports shared in these days go into it."
          initial={mine.nextPeriod}
          latest={mine.nextPeriod.to}
          doing="Starting…"
          done="Start draft"
          save={(chosen) =>
            draftCeoReport(chosen).then((report) => {
              window.location.hash = `#/clients/ceo-report/${report.id}`;
            })
          }
          onClose={() => {
            setDrafting(false);
          }}
          onSignedOut={onSignedOut}
        />
      ) : null}
    </section>
  );
}

/** The Chief Executive's page: every CEO report submitted to them, newest first. */
export function ReceivedCeoReports({ onSignedOut }: { onSignedOut: () => void }) {
  const { list, problem, load } = useCeoReports(onSignedOut);
  const received = list?.received ?? null;

  return (
    <section className="clients-panel clients-reports" aria-labelledby="clients-received-heading">
      <header className="clients-panel-head">
        <div>
          <h3 id="clients-received-heading">CEO reports</h3>
          <p className="muted">Reports the BD managers have submitted to you, newest first.</p>
        </div>
      </header>

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {received === null ? null : received.length === 0 ? (
        <p className="muted clients-reports-none">No reports have been submitted to you yet.</p>
      ) : (
        <CeoReportList reports={received} withAuthor />
      )}
    </section>
  );
}

const STATUS_NAME: Record<CeoReport['status'], string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  DISCARDED: 'Discarded',
};

function CeoReportList({
  reports,
  withAuthor = false,
}: {
  reports: readonly CeoReport[];
  withAuthor?: boolean;
}) {
  return (
    <table className="clients-deals clients-reports-list">
      <thead>
        <tr>
          {withAuthor ? <th scope="col">From</th> : null}
          <th scope="col">Period</th>
          <th scope="col">Status</th>
          <th scope="col">When</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((report) => (
          <tr key={report.id}>
            {withAuthor ? <td>{report.author.name}</td> : null}
            <td data-label={withAuthor ? 'Period' : undefined}>
              <a href={`#/clients/ceo-report/${report.id}`}>
                {period(report.period.from, report.period.to)}
              </a>
            </td>
            <td data-label="Status">
              <span className="clients-stage-chip">{STATUS_NAME[report.status]}</span>
            </td>
            <td data-label="When">
              {report.submittedAt === null
                ? `Started ${moment(report.createdAt)}`
                : `Submitted ${moment(report.submittedAt)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
