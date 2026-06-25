-- Re-seed demo reports.owner_login to the repo URL namespace (was the maintainer
-- handle). Idempotent: each UPDATE is guarded by the old value so re-runs are no-ops.
-- (The demo forensic record for fastlib/crypto-utils is loaded as one-time live demo
-- data, not embedded here — its inert captured decoy payload contains key-shaped bytes
-- that the repo's secret scanner would flag; real scans populate forensics_json in prod.)
update public.reports set owner_login = 'verdant'    where repo_name = 'ratchet'        and owner_login = 'soren-vestergaard';
update public.reports set owner_login = 'marlow'     where repo_name = 'envguard'       and owner_login = 'marlow-dev';
update public.reports set owner_login = 'quickdev'   where repo_name = 'setup-helper'   and owner_login = 'quickdev-tools';
update public.reports set owner_login = 'corewallet' where repo_name = 'keystore-tools' and owner_login = 'corewallet-io';
update public.reports set owner_login = 'fastlib'    where repo_name = 'crypto-utils'   and owner_login = 'fastlib-pkg';
