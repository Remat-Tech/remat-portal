import { useState } from 'react';
import type { ReportSection } from '../../api';
import { Notice } from '../../problem';
import { Dialog, DialogFoot, Field, useSending } from './ui';

/**
 * What the meeting report (#291) and CEO report (#292) pages share: the written sections, the
 * dialog that writes them, and a dialog that asks before doing something that cannot be undone.
 */

/**
 * What the author wrote: placeholder headings until the team confirms what a report holds. None is
 * needed to send it on.
 */
export function WrittenSections({
  title = 'Written sections',
  sections,
  onWrite,
}: {
  title?: string;
  sections: readonly ReportSection[];
  /** Opens the dialog; only where the reader may write them. */
  onWrite?: () => void;
}) {
  return (
    <section className="clients-panel clients-report-section clients-report-written">
      <header className="clients-panel-head">
        <div>
          <h3>{title}</h3>
          <p className="muted">Placeholders until the team confirms what a report holds.</p>
        </div>
        {onWrite === undefined ? null : (
          <button type="button" onClick={onWrite}>
            Write sections
          </button>
        )}
      </header>
      <dl className="clients-report-written-list">
        {sections.map((section) => (
          <div key={section.key}>
            <dt>{section.heading}</dt>
            <dd className={section.body === null ? 'muted' : undefined}>
              {section.body ?? 'Nothing written'}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Writing every section in one go: a text box each, each may be left empty. */
export function SectionsDialog({
  sections,
  save,
  onClose,
  onSignedOut,
}: {
  sections: readonly ReportSection[];
  /** Sends the words, by section key; closes the dialog when it is done. */
  save: (words: Record<string, string>) => Promise<unknown>;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [words, setWords] = useState<Record<string, string>>(() =>
    Object.fromEntries(sections.map((section) => [section.key, section.body ?? ''])),
  );
  const sending = useSending(() => undefined, onSignedOut);
  const fields = sections.map((section) => `sections.${section.key}`);
  const other = sending.other(fields);

  return (
    <Dialog title="Write sections" intro="Each may be left empty." wide onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => save(words));
        }}
      >
        {sections.map((section) => (
          <Field
            key={section.key}
            label={section.heading}
            error={sending.errorFor(`sections.${section.key}`)}
          >
            {({ id: fieldId, describedBy }) => (
              <textarea
                id={fieldId}
                rows={4}
                maxLength={4000}
                value={words[section.key] ?? ''}
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  const value = event.target.value;
                  setWords((was) => ({ ...was, [section.key]: value }));
                }}
              />
            )}
          </Field>
        ))}

        {other === undefined ? null : <Notice problem={other} />}

        <DialogFoot busy={sending.busy} doing="Saving…" done="Save" onCancel={onClose} />
      </form>
    </Dialog>
  );
}

/** Asks before doing something that cannot be undone: sharing, submitting, discarding. */
export function ConfirmDialog({
  title,
  intro,
  doing,
  done,
  run,
  onClose,
  onSignedOut,
}: {
  title: string;
  intro: string;
  /** "Sharing…". */
  doing: string;
  /** "Share". */
  done: string;
  /** Does it; whatever follows, like closing the dialog, is the caller's. */
  run: () => Promise<unknown>;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const sending = useSending(() => undefined, onSignedOut);
  const other = sending.other([]);

  return (
    <Dialog title={title} intro={intro} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(run);
        }}
      >
        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot busy={sending.busy} doing={doing} done={done} onCancel={onClose} />
      </form>
    </Dialog>
  );
}

/** Accra is UTC all year, so the browser's UTC day is the company's. */
export function todayInAccra(): string {
  return new Date().toISOString().slice(0, 10);
}
