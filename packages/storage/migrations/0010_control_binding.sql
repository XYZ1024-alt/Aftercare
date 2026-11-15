-- 0010_control_binding.sql — a stored document must agree with the row it is
-- filed under.
--
-- Certificates and evidence are stored as JSON bodies next to the columns the
-- foreign keys bind (case, snapshot, digest). These constraints make a body
-- that names a different case or snapshot, or an evidence body that carries a
-- different result digest than its row, unrepresentable — for every role,
-- including the owner.

ALTER TABLE aftercare_control.completeness_certificates
  ADD CONSTRAINT certificates_body_binding CHECK (
    body ->> 'caseId' = case_id::text
    AND body ->> 'snapshotId' = snapshot_id::text
  );

ALTER TABLE aftercare_control.evidence
  ADD CONSTRAINT evidence_body_binding CHECK (
    body ->> 'caseId' = case_id::text
    AND body ->> 'snapshotId' = snapshot_id::text
    AND body ->> 'resultDigest' = result_digest
  );
