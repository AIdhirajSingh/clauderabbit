-- Key day step 7: the read-only SQL behind db-before.txt / db-after.txt and the v2 advisor check.
-- Each block ran as its own `supabase db query --linked --project-ref mjvlczaytkhvsolnhhkz -f <file>`.

-- rowcounts.sql
select t.table_name,
 (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.table_name), false, true, '')))[1]::text::bigint as rows
from information_schema.tables t where t.table_schema='public' and t.table_type='BASE TABLE' order by 1;

-- migrations.sql
select version, name from supabase_migrations.schema_migrations order by version;

-- fingerprint.sql
with s(n) as (values ('public'),('auth'),('realtime'),('storage')),
cols as (select table_schema s, md5(string_agg(table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,'')||':'||is_nullable, '|' order by table_name, ordinal_position)) h from information_schema.columns where table_schema in (select n from s) group by 1),
cons as (select n.nspname s, md5(string_agg(c.conrelid::regclass::text||'.'||c.conname||':'||pg_get_constraintdef(c.oid), '|' order by c.conrelid::regclass::text, c.conname)) h from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in (select n from s) group by 1),
idx as (select schemaname s, md5(string_agg(indexdef, '|' order by tablename, indexname)) h from pg_indexes where schemaname in (select n from s) group by 1),
fns as (select n.nspname s, md5(string_agg(p.oid::regprocedure::text||':'||md5(coalesce(p.prosrc,''))||':'||coalesce(p.proacl::text,'')||':'||p.prosecdef::text||':'||coalesce(array_to_string(p.proconfig,','),''), '|' order by p.oid::regprocedure::text)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in (select n from s) group by 1),
pol as (select schemaname s, md5(string_agg(tablename||'.'||policyname||':'||cmd||':'||array_to_string(roles,',')||':'||coalesce(qual,'')||':'||coalesce(with_check,''), '|' order by tablename, policyname)) h from pg_policies where schemaname in (select n from s) group by 1),
trg as (select n.nspname s, md5(string_agg(c.relname||'.'||t.tgname||':'||pg_get_triggerdef(t.oid), '|' order by c.relname, t.tgname)) h from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in (select n from s) group by 1),
acl as (select n.nspname s, md5(string_agg(c.relname||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text, '|' order by c.relname)) h from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in (select n from s) group by 1)
select s.n as schema, cols.h cols, cons.h cons, idx.h idx, fns.h fns, pol.h pol, trg.h trg, acl.h acl,
 md5(concat_ws('/',cols.h,cons.h,idx.h,fns.h,pol.h,trg.h,acl.h)) as total
from s left join cols on cols.s=s.n left join cons on cons.s=s.n left join idx on idx.s=s.n left join fns on fns.s=s.n left join pol on pol.s=s.n left join trg on trg.s=s.n left join acl on acl.s=s.n order by 1;

-- v2objects.sql
select 'schema' k, nspname o from pg_namespace where nspname='v2'
union all select 'role', rolname||' login='||rolcanlogin||' bypassrls='||rolbypassrls||' inherit='||rolinherit||' connlimit='||rolconnlimit from pg_roles where rolname='cr_v2_server'
union all select 'rel:'||c.relkind::text, c.relname||' rls='||c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='v2'
union all select 'fn', p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='v2'
union all select 'policy', tablename||'.'||policyname||' to '||array_to_string(roles,',') from pg_policies where schemaname='v2'
order by 1,2;

-- advisor.sql (the Supabase security advisor's lints, applied to schema v2)
select 'rls_disabled' lint, c.relname obj from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='v2' and c.relkind in ('r','p') and not c.relrowsecurity
union all select 'rls_enabled_no_policy', c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='v2' and c.relkind in ('r','p') and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname='v2' and p.tablename=c.relname)
union all select 'function_search_path_mutable', p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='v2' and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) x where x like 'search_path=%')
union all select 'function_exec_by_'||r.rolname, p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role','authenticator') union all select 'public') r where n.nspname='v2' and has_function_privilege(case when r.rolname='public' then 'pg_database_owner' else r.rolname end, p.oid, 'execute') and r.rolname<>'public'
union all select 'function_exec_by_PUBLIC', p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where n.nspname='v2' and a.grantee=0 and a.privilege_type='EXECUTE'
union all select 'table_grant_to_'||g.grantee, g.table_name||':'||g.privilege_type from information_schema.role_table_grants g where g.table_schema='v2' and g.grantee in ('anon','authenticated','service_role','authenticator','PUBLIC')
union all select 'schema_usage_by_'||r, 'v2' from unnest(array['anon','authenticated','service_role','authenticator']) r where has_schema_privilege(r,'v2','usage')
union all select 'schema_exposed_pgrst', coalesce((select array_to_string(setconfig,',') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='authenticator'),'none') where coalesce((select array_to_string(setconfig,',') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='authenticator'),'') like '%v2%'
union all select 'secdef_functions(info)', string_agg(p.proname,',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='v2' and p.prosecdef
order by 1,2;
