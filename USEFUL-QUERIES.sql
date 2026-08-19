List recent accounts:
SELECT pid, name, datetime(created/1000,'unixepoch') AS joined FROM players ORDER BY created DESC LIMIT 20;

Count accounts:
SELECT COUNT(*) FROM players;

Delete a test account:
DELETE FROM players WHERE name = 'Testy';

Wipe everything and start over:
DROP TABLE players;

Confirm the table exists:
SELECT name FROM sqlite_master WHERE type='table';

Inspect one player's save blob:
SELECT save FROM players WHERE name = 'YourName';
