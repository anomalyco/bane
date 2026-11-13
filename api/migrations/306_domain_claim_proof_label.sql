-- The ownership TXT record a claim shows is _<proof_label>.<domain>. Claims made before the Nightmail rename keep the
-- _bane record their owner already published; new claims show _nightmail. Verification accepts every label.
ALTER TABLE domain_claims ADD COLUMN proof_label text NOT NULL DEFAULT 'bane' CHECK (proof_label IN ('nightmail', 'bane', 'opensend'));
ALTER TABLE domain_claims ALTER COLUMN proof_label SET DEFAULT 'nightmail';
