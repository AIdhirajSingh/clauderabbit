-- ClaudeRabbit 2.0: MP4 export is removed, so its state table goes. Touches
-- schema v2 only. Refuses to run while v2.exports holds any row, so no export
-- record is ever dropped silently.
--
-- Reverse path: supabase/migrations-down/20261021000003_v2_drop_exports.down.sql

do $$
begin
  if exists (select 1 from v2.exports) then
    raise exception 'v2.exports is not empty';
  end if;
end
$$;

drop table v2.exports;
