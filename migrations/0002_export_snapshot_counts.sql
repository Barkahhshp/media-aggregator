ALTER TABLE export_sessions
  ADD COLUMN snapshot_sources_count INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_sources_count >= 0);
ALTER TABLE export_sessions
  ADD COLUMN snapshot_pending_items_count INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_pending_items_count >= 0);
ALTER TABLE export_sessions
  ADD COLUMN snapshot_articles_count INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_articles_count >= 0);

UPDATE export_sessions
SET snapshot_sources_count = (SELECT COUNT(*) FROM sources),
    snapshot_pending_items_count = (SELECT COUNT(*) FROM pending_items),
    snapshot_articles_count = (SELECT COUNT(*) FROM articles)
WHERE state = 'active';
