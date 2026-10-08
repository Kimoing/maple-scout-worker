ALTER TABLE characters ADD COLUMN world_name TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN character_class TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN character_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN character_image TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN scheduler_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE characters ADD COLUMN scheduler_date TEXT NOT NULL DEFAULT '';
