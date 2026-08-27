ALTER TABLE jobs ADD COLUMN trigger_json TEXT;

ALTER TABLE job_runs ADD COLUMN event_id TEXT;

CREATE UNIQUE INDEX job_runs_job_event_id
	ON job_runs(job_id, event_id)
	WHERE event_id IS NOT NULL;
