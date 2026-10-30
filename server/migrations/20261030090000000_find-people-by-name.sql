-- Up Migration

-- Finding somebody by the start of a name, whatever the case. Two indexes rather than one over
-- both columns, because a search may start from either name.
--
-- `text_pattern_ops` is what lets `lower(last_name) LIKE 'bo%'` use one under any collation.
--
-- Departments need nothing here: `idx_employee_department` finds a department's people, and
-- `department_name_unique` finds a department by name.

CREATE INDEX employee_by_last_name ON employee (lower(last_name) text_pattern_ops);
CREATE INDEX employee_by_first_name ON employee (lower(first_name) text_pattern_ops);

-- Down Migration

DROP INDEX IF EXISTS employee_by_first_name;
DROP INDEX IF EXISTS employee_by_last_name;
