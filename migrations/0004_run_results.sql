CREATE TABLE job_runs_with_results (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error', 'expired')),
	error TEXT,
	duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
	source TEXT NOT NULL CHECK (source IN ('schedule', 'manual', 'trigger')),
	event_id TEXT,
	result_json TEXT
);

INSERT INTO job_runs_with_results (
	id, job_id, started_at, finished_at, status, error, duration_ms, source,
	event_id, result_json
)
	SELECT id, job_id, started_at, finished_at, status, error, duration_ms,
		source, event_id, NULL
	FROM job_runs;

DROP TABLE job_runs;

ALTER TABLE job_runs_with_results RENAME TO job_runs;

CREATE INDEX job_runs_job_started_at
	ON job_runs(job_id, started_at);
