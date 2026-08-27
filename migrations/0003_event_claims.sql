CREATE TABLE event_claims (
	job_id TEXT NOT NULL,
	event_id TEXT NOT NULL,
	claimed_at TEXT NOT NULL,
	PRIMARY KEY (job_id, event_id)
);

-- Preserve claims already recorded while 0002 was active.
INSERT OR IGNORE INTO event_claims (job_id, event_id, claimed_at)
	SELECT job_id, event_id, started_at
	FROM job_runs
	WHERE event_id IS NOT NULL;

CREATE INDEX event_claims_claimed_at
	ON event_claims(claimed_at);

DROP INDEX job_runs_job_event_id;
