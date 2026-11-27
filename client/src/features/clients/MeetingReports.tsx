import { useCallback, useEffect, useState } from 'react';
import {
  draftMeetingReport,
  isNotSignedIn,
  type MeetingReport,
  myMeetingReports,
  type MyMeetingReports,
  type ReportPeriod,
} from '../../api';
import { moment, period } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Dialog, DialogFoot, Field, useSending } from './ui';

/**
 * My reports, on My pipeline: what I bring to my meeting with a BD manager. #291, Clients SRS CLI
 * 79 to CLI 82.
 *
 * Each covers a period. A new one is offered the days since the period of the one shared last, or
 * since my clients role began, up to today, and either day may be changed. One draft at a time:
 * while there is one, the button opens it instead. Each report opens on its own page.
 *
 * A BD manager also gets everybody else's shared reports, under their own (#291).
 */
export function MeetingReports({ onSignedOut }: { onSignedOut: () => void }) {
  const [mine, setMine] = useState<MyMeetingReports | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [drafting, setDrafting] = useState(false);

  const load = useCallback(() => {
    myMeetingReports()
      .then((found) => {
        setMine(found);
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

  return (
    <>
      <section className="clients-panel clients-reports" aria-labelledby="clients-reports-heading">
        <header className="clients-panel-head">
          <div>
            <h3 id="clients-reports-heading">My reports</h3>
            <p className="muted">For your meeting with a BD manager.</p>
          </div>
          {mine === undefined ? null : mine.draftId !== null ? (
            <a className="button-link primary" href={`#/clients/report/${mine.draftId}`}>
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
              New report
            </button>
          )}
        </header>

        {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

        {mine === undefined ? null : mine.reports.length === 0 ? (
          <p className="muted clients-reports-none">
            No reports yet. Start one before your next meeting.
          </p>
        ) : (
          <ReportList reports={mine.reports} />
        )}

        {drafting && mine !== undefined ? (
          <PeriodDialog
            title="New report"
            intro="The days it covers. It starts the day after your last shared report, or the day your role began."
            initial={mine.nextPeriod}
            latest={mine.nextPeriod.to}
            doing="Starting…"
            done="Start draft"
            save={(period) =>
              draftMeetingReport(period).then((report) => {
                window.location.hash = `#/clients/report/${report.id}`;
              })
            }
            onClose={() => {
              setDrafting(false);
            }}
            onSignedOut={onSignedOut}
          />
        ) : null}
      </section>

      {/* A BD manager's: everybody else's shared reports (the user, 25 November 2026). */}
      {mine?.shared == null ? null : (
        <section
          className="clients-panel clients-reports"
          aria-labelledby="clients-shared-reports-heading"
        >
          <header className="clients-panel-head">
            <div>
              <h3 id="clients-shared-reports-heading">Shared reports</h3>
              <p className="muted">Shared with the BD managers, newest first.</p>
            </div>
          </header>
          {mine.shared.length === 0 ? (
            <p className="muted clients-reports-none">Nobody has shared a report yet.</p>
          ) : (
            <ReportList reports={mine.shared} withAuthor />
          )}
        </section>
      )}
    </>
  );
}

/** Newest first: the days each covers, whether it is shared, and when. */
function ReportList({
  reports,
  withAuthor = false,
}: {
  reports: readonly MeetingReport[];
  /** Whose each is, for a list of other people's. */
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
              <a href={`#/clients/report/${report.id}`}>
                {period(report.period.from, report.period.to)}
              </a>
            </td>
            <td data-label="Status">
              <span className="clients-stage-chip">
                {report.status === 'DRAFT' ? 'Draft' : 'Shared'}
              </span>
            </td>
            <td data-label="When">
              {report.sharedAt === null
                ? `Started ${moment(report.createdAt)}`
                : `Shared ${moment(report.sharedAt)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The days a report covers, as a dialog: offered for a new draft, or a draft's own to change. It
 * ends today at the latest, and never starts after it ends; the server holds both.
 */
export function PeriodDialog({
  title,
  intro,
  initial,
  latest,
  doing,
  done,
  save,
  onClose,
  onSignedOut,
}: {
  title: string;
  intro: string;
  initial: ReportPeriod;
  /** Today: the last day it may cover. */
  latest: string;
  /** "Starting…". */
  doing: string;
  /** "Start draft". */
  done: string;
  save: (period: ReportPeriod) => Promise<unknown>;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const sending = useSending(() => undefined, onSignedOut);
  const other = sending.other(['from', 'to']);

  return (
    <Dialog title={title} intro={intro} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => save({ from, to }));
        }}
      >
        <div className="clients-field-row">
          <Field label="From" error={sending.errorFor('from')}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="date"
                value={from}
                max={to}
                required
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setFrom(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label="To" error={sending.errorFor('to')}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="date"
                value={to}
                min={from}
                max={latest}
                required
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setTo(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        {other === undefined ? null : <Notice problem={other} />}

        <DialogFoot
          busy={sending.busy}
          disabled={from === '' || to === ''}
          doing={doing}
          done={done}
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}
