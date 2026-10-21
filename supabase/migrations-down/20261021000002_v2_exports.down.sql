-- Reverse of 20261021000002_v2_exports.sql (schema v2 and the v2-exports bucket only).
-- Empty the bucket through the Storage API first; a bucket with objects cannot be deleted.
drop table if exists v2.exports;
delete from storage.buckets where id = 'v2-exports';
