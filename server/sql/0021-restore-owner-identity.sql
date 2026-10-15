-- The former OAuth handler bound GitHub's numeric ID to a TEXT column.
-- D1 stored it as "121328491.0". The normalized handler then created
-- user 7 for the same GitHub account, hiding user 1's private records.
-- Preserve the new diary by moving its authorship to the original account.
-- No user or content row is deleted.
UPDATE feeds SET uid = 1
WHERE uid = 7
  AND EXISTS (SELECT 1 FROM users WHERE id = 1 AND openid = '121328491.0')
  AND EXISTS (SELECT 1 FROM users WHERE id = 7 AND openid = '121328491');

-- Retire the duplicate login identity without deleting its row. Existing
-- tokens for user 7 lose owner privileges until the next GitHub sign-in.
UPDATE users SET openid = 'merged:github:121328491:7', permission = 0
WHERE id = 7 AND openid = '121328491'
  AND EXISTS (SELECT 1 FROM users WHERE id = 1 AND openid = '121328491.0');

UPDATE users SET openid = '121328491'
WHERE id = 1 AND openid = '121328491.0'
  AND NOT EXISTS (SELECT 1 FROM users WHERE openid = '121328491');

INSERT INTO info (key, value) VALUES ('migration_version', '21')
ON CONFLICT(key) DO UPDATE SET value = '21';
