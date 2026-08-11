ALTER TABLE autonomous_decisions ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE autonomous_decisions ADD COLUMN invalidation_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE autonomous_decisions ADD COLUMN invalidation_price REAL;
