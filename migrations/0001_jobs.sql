CREATE TABLE jobs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	code TEXT NOT NULL,
	schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json)),
	timezone TEXT,
	enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
	owner_props_json TEXT NOT NULL CHECK (json_valid(owner_props_json)),
	expires_at TEXT,
	next_run_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_run_at TEXT,
	last_run_status TEXT CHECK (last_run_status IN ('success', 'error', 'expired')),
	last_run_error TEXT,
	last_duration_ms INTEGER CHECK (last_duration_ms IS NULL OR last_duration_ms >= 0),
	run_count INTEGER NOT NULL DEFAULT 0,
	success_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0
);

-- Run evidence survives deletion of the scheduled job, so this has no foreign key.
CREATE TABLE job_runs (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error', 'expired')),
	error TEXT,
	duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
	source TEXT NOT NULL CHECK (source IN ('schedule', 'manual'))
);

CREATE INDEX job_runs_job_started_at
	ON job_runs(job_id, started_at);
