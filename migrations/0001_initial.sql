CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by_sub TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, email)
);

CREATE TABLE characters (
  google_sub TEXT NOT NULL,
  nickname TEXT NOT NULL,
  ocid TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (google_sub, nickname),
  UNIQUE (google_sub, ocid)
);

CREATE INDEX group_members_by_email ON group_members(email COLLATE NOCASE);
CREATE INDEX characters_by_nickname ON characters(nickname COLLATE NOCASE);