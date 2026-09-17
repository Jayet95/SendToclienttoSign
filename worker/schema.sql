-- Patient records for SendToClientToSign.
-- Each row stores one patient as a JSON document (patient fields + treatments),
-- keyed by the patient's national id (ת.ז).
CREATE TABLE IF NOT EXISTS patients (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patients_updated ON patients (updated_at DESC);
