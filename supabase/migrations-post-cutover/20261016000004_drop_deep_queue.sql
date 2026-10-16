-- ClaudeRabbit 2.0: the deep queue is gone; every scan runs the code in one
-- request (DESIGN.md section 1.1). Drops the queue, the dispatch lock and their RPCs.
-- Reverse path: supabase/migrations-post-cutover/20261016000004_drop_deep_queue.down.sql
-- (recreates them from the original DDL of 20260702000002, 20260703000001, 20260711000001).

drop function if exists public.deep_queue_enqueue(text, text, text, text);
drop function if exists public.deep_queue_position(text);
drop function if exists public.deep_queue_set_status(text, public.deep_scan_queue_status);
drop function if exists public.deep_queue_set_stage(text, text, text);
drop function if exists public.deep_queue_get_stage(text);
drop function if exists public.deep_dispatch_try_claim(text, text, text, text, integer);
drop function if exists public.deep_dispatch_release(text, text, text, text);
drop table if exists public.deep_dispatch_lock;
drop table if exists public.deep_scan_queue;
drop type if exists public.deep_scan_queue_status;
