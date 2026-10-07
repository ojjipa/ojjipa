-- Version 5 was used by the removed agent runtime during development.
-- Keep its version slot so existing databases can migrate forward without
-- lowering user_version or deleting their saved records and extra tables.
SELECT 1;
