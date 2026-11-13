-- Use the final row, including fields omitted by an update request. A draft
-- edit racing with publication must never put the reserved reference online.
CREATE TRIGGER IF NOT EXISTS feeds_private_media_before_insert
BEFORE INSERT ON feeds
WHEN NEW.draft = 0 AND NEW.kind NOT IN ('diary','memo') AND (
  instr(NEW.content, 'private-media:') > 0 OR instr(NEW.summary, 'private-media:') > 0
  OR instr(NEW.title, 'private-media:') > 0 OR instr(coalesce(NEW.alias, ''), 'private-media:') > 0
)
BEGIN
  SELECT RAISE(ABORT, 'PRIVATE_MEDIA_PUBLICATION_BLOCKED');
END;

CREATE TRIGGER IF NOT EXISTS feeds_private_media_before_update
BEFORE UPDATE OF draft,kind,content,summary,title,alias ON feeds
WHEN NEW.draft = 0 AND NEW.kind NOT IN ('diary','memo') AND (
  instr(NEW.content, 'private-media:') > 0 OR instr(NEW.summary, 'private-media:') > 0
  OR instr(NEW.title, 'private-media:') > 0 OR instr(coalesce(NEW.alias, ''), 'private-media:') > 0
)
BEGIN
  SELECT RAISE(ABORT, 'PRIVATE_MEDIA_PUBLICATION_BLOCKED');
END;
