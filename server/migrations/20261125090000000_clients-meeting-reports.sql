-- Up Migration

-- Meeting reports: what an associate brings to their meeting with a BD manager. #291, Clients
-- SRS CLI 79 to CLI 82.
--
-- **A report covers a period**, from one day to another, both included. The screen offers the
-- day after the period of the report its author shared last, or for a first report the day their
-- clients role began, up to today (the user, 25 November 2026). The service works that out; the
-- table holds only that a period runs forwards.
--
-- **One draft at a time** for each author (the user, 25 November 2026): starting another opens
-- the one there is. Periods may overlap, so two reports may cover the same days.
--
-- **Its figures are saved with it** (the user, 25 November 2026): the lists and the counts its
-- page shows, as they stood when the draft was started, so that a step reopened, a deal moved or a
-- client renamed later does not change what it said. Its author may update them while it is a
-- draft; sharing saves them a last time and fixes them.
--
-- **Its written sections are placeholders** until the team confirms what a report holds (the
-- user, 25 November 2026): the headings come from a list in the code and are copied onto each
-- draft as it starts, so changing the list later changes no report. Each may be left empty.
--
-- **A draft is edited by its author** (the user, 25 November 2026): its period, which saves its
-- figures afresh, and its written sections. **Or discarded**, which frees its author to
-- start another; a discarded draft is kept, as nothing in clients is deleted. Shared or discarded,
-- a report is never changed again, which the trigger below holds whoever asks.
--
-- **Sharing** saves its figures a last time and fixes it, and from then **every BD manager may
-- read it** (the user, 25 November 2026); they are emailed, in the same transaction.
--
-- **Written by anybody with a clients role**, BD managers included, and read by its author;
-- the policy's (readMeetingReport, writeMeetingReport).

CREATE TABLE clients_meeting_report (
    id           BIGSERIAL PRIMARY KEY,
    /* Who wrote it, for good. */
    author_id    BIGINT NOT NULL REFERENCES employee(id),
    /* The days it covers, both included. */
    period_from  DATE NOT NULL,
    period_to    DATE NOT NULL,

    /* Its lists and counts, { contents, tally }, as of figures_at. Built by the service. */
    figures      JSONB NOT NULL,
    figures_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* What its author wrote: [{ key, heading, body }], body null where nothing is written. */
    sections     JSONB NOT NULL DEFAULT '[]',

    status       VARCHAR(9) NOT NULL DEFAULT 'DRAFT',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* When it was shared, which is what makes it the last shared one. Null while a draft. */
    shared_at    TIMESTAMPTZ,
    /* When its author threw it away, or null. */
    discarded_at TIMESTAMPTZ,

    CONSTRAINT clients_meeting_report_status_known
        CHECK (status IN ('DRAFT', 'SHARED', 'DISCARDED')),
    CONSTRAINT clients_meeting_report_period_runs_forwards CHECK (period_from <= period_to),
    CONSTRAINT clients_meeting_report_shared_when
        CHECK ((status = 'SHARED') = (shared_at IS NOT NULL)),
    CONSTRAINT clients_meeting_report_discarded_when
        CHECK ((status = 'DISCARDED') = (discarded_at IS NOT NULL)),
    CONSTRAINT clients_meeting_report_sections_a_list CHECK (jsonb_typeof(sections) = 'array')
);

/* One draft each at a time. */
CREATE UNIQUE INDEX uq_clients_meeting_report_one_draft
    ON clients_meeting_report (author_id) WHERE status = 'DRAFT';

/* Somebody's reports, and the one they shared last, which the next period starts after. */
CREATE INDEX idx_clients_meeting_report_author
    ON clients_meeting_report (author_id, shared_at DESC);

-- ------------------------------------------------------------- fixed once settled, TDD 4.7

/* A draft changes; a report shared or discarded never does again, whoever asks. */
CREATE FUNCTION clients_meeting_report_fixed_once_settled() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'This meeting report is %, so it stays as it is.', lower(OLD.status)
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_meeting_report_fixed_once_settled';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_meeting_report_fixed_once_settled
    BEFORE UPDATE ON clients_meeting_report
    FOR EACH ROW EXECUTE FUNCTION clients_meeting_report_fixed_once_settled();

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

CREATE TRIGGER clients_meeting_report_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_meeting_report
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. A draft's period,
   figures and sections are changed by its author, and it is shared or discarded. Its author never
   changes, and nothing is deleted. */
GRANT UPDATE (period_from, period_to, figures, figures_at, sections, status, shared_at,
              discarded_at)
    ON clients_meeting_report TO lms_app;

-- Down Migration

DROP TABLE IF EXISTS clients_meeting_report;
DROP FUNCTION IF EXISTS clients_meeting_report_fixed_once_settled();
