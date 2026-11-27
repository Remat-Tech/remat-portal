-- Up Migration

-- The report to the CEO: a BD manager's, built from the meeting reports shared in a period and the
-- pipeline as it stands. #292, Clients SRS CLI 83.
--
-- **The same model as a meeting report** (the user, 27 November 2026): each BD manager drafts
-- their own, one draft at a time, for a period that may overlap another; its figures are saved
-- with it and may be updated while it is a draft; its period and its written sections are its
-- author's to change, or it is discarded and kept. The period offered starts the day after the
-- last one its author submitted, or the 1st of the month for a first; the service works that out.
--
-- **Submitting** saves its figures a last time and fixes it for good, and from then the person
-- the organisation names as its Chief Executive may read it, and is emailed, in one transaction.
-- Who that was is kept with it. Nothing is ever sent but by its author submitting it.

CREATE TABLE clients_ceo_report (
    id            BIGSERIAL PRIMARY KEY,
    /* The BD manager who wrote it, for good. */
    author_id     BIGINT NOT NULL REFERENCES employee(id),
    /* The days it covers, both included. */
    period_from   DATE NOT NULL,
    period_to     DATE NOT NULL,

    /* Its team table, pipeline and the associates' words, as of figures_at. Built by the service. */
    figures       JSONB NOT NULL,
    figures_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* What its author wrote: [{ key, heading, body }], body null where nothing is written. */
    sections      JSONB NOT NULL DEFAULT '[]',

    status        VARCHAR(9) NOT NULL DEFAULT 'DRAFT',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* When it was submitted, and to whom: the Chief Executive then. Null while a draft. */
    submitted_at  TIMESTAMPTZ,
    submitted_to  BIGINT REFERENCES employee(id),
    /* When its author threw it away, or null. */
    discarded_at  TIMESTAMPTZ,

    CONSTRAINT clients_ceo_report_status_known
        CHECK (status IN ('DRAFT', 'SUBMITTED', 'DISCARDED')),
    CONSTRAINT clients_ceo_report_period_runs_forwards CHECK (period_from <= period_to),
    CONSTRAINT clients_ceo_report_submitted_when CHECK (
        (status = 'SUBMITTED') = (submitted_at IS NOT NULL)
        AND (submitted_at IS NULL) = (submitted_to IS NULL)),
    CONSTRAINT clients_ceo_report_discarded_when
        CHECK ((status = 'DISCARDED') = (discarded_at IS NOT NULL)),
    CONSTRAINT clients_ceo_report_sections_a_list CHECK (jsonb_typeof(sections) = 'array')
);

/* One draft each at a time. */
CREATE UNIQUE INDEX uq_clients_ceo_report_one_draft
    ON clients_ceo_report (author_id) WHERE status = 'DRAFT';

/* Somebody's reports, and the one they submitted last, which the next period starts after. */
CREATE INDEX idx_clients_ceo_report_author ON clients_ceo_report (author_id, submitted_at DESC);

/* The meeting reports shared in a period, which a CEO report is built from. */
CREATE INDEX idx_clients_meeting_report_shared
    ON clients_meeting_report (shared_at) WHERE status = 'SHARED';

-- ------------------------------------------------------------- fixed once settled, TDD 4.7

/* A draft changes; a report submitted or discarded never does again, whoever asks. */
CREATE FUNCTION clients_ceo_report_fixed_once_settled() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'This CEO report is %, so it stays as it is.', lower(OLD.status)
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_ceo_report_fixed_once_settled';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_ceo_report_fixed_once_settled
    BEFORE UPDATE ON clients_ceo_report
    FOR EACH ROW EXECUTE FUNCTION clients_ceo_report_fixed_once_settled();

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

CREATE TRIGGER clients_ceo_report_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_ceo_report
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. A draft's period,
   figures and sections are changed by its author, and it is submitted or discarded. Its author
   never changes, and nothing is deleted. */
GRANT UPDATE (period_from, period_to, figures, figures_at, sections, status, submitted_at,
              submitted_to, discarded_at)
    ON clients_ceo_report TO lms_app;

-- Down Migration

DROP INDEX IF EXISTS idx_clients_meeting_report_shared;
DROP TABLE IF EXISTS clients_ceo_report;
DROP FUNCTION IF EXISTS clients_ceo_report_fixed_once_settled();
