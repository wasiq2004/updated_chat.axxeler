-- 058: Rename forgecrm_users to z_chat_users (branding cleanup).
-- Foreign-key constraints still work after a rename — Postgres tracks them by
-- table OID, not by name — so no FK changes are needed here.
ALTER TABLE IF EXISTS coexistence.forgecrm_users RENAME TO z_chat_users;
