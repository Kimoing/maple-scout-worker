CREATE TABLE bosses (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  boss_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (group_id, boss_id)
);