-- Patient records for SendToClientToSign, scoped per authenticated user (Clerk).
-- Each row is one patient as a JSON document, owned by a Clerk user (user_id).
DROP TABLE IF EXISTS patients;
CREATE TABLE patients (
  user_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc        TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_patients_user ON patients (user_id, updated_at DESC);
