CREATE TABLE multipliers (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL COLLATE NOCASE,
  boss_id TEXT NOT NULL,
  multiplier REAL NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (group_id, nickname, boss_id)
);

CREATE INDEX multipliers_by_group ON multipliers(group_id, nickname COLLATE NOCASE);