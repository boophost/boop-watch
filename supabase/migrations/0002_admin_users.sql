-- Admin roles move out of Supabase Auth metadata (app_metadata.role /
-- user_metadata.admin) into this table. Presence of a row = admin; revoke by
-- deleting the row. The ADMIN_EMAILS env allowlist remains a separate,
-- unrevocable super-admin tier layered on top in server code.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
-- No policies: RLS with zero policies denies all PostgREST access for
-- anon/authenticated. Server-side access goes through service_role, which
-- bypasses RLS. The revoke is defense-in-depth against the broad default
-- grants self-hosted Supabase bootstraps onto the public schema.
revoke all on public.admin_users from anon, authenticated;
grant select, insert, update, delete on public.admin_users to service_role;

-- Backfill from the metadata previously written by setUserAdmin. Data-driven
-- so the same file works on dev/staging Supabase instances with different
-- admin sets; safe to re-run.
insert into public.admin_users (user_id)
select id from auth.users
where coalesce(raw_app_meta_data->>'role', '') = 'admin'
   or coalesce((raw_user_meta_data->>'admin')::boolean, false)
on conflict (user_id) do nothing;

-- Read-only projection of auth.users + auth.identities for analytics
-- (PostHog's warehouse role reads the public schema). Excludes every
-- credential/token column on auth.users (encrypted_password, recovery_token,
-- confirmation_token, reauthentication_token, email_change_token_*,
-- phone_change_token). Runs with the owner's privileges, so grantees never
-- need direct access to the auth schema.
create or replace view public.auth_users_safe as
select
  u.id,
  u.email,
  u.created_at,
  u.updated_at,
  u.last_sign_in_at,
  u.email_confirmed_at,
  u.banned_until,
  u.is_anonymous,
  u.deleted_at,
  (au.user_id is not null) as is_admin,
  coalesce(ids.identities, '[]'::jsonb) as identities
from auth.users u
left join public.admin_users au on au.user_id = u.id
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'provider_id', i.provider_id,
      'provider', i.provider,
      'identity_data', i.identity_data,
      'last_sign_in_at', i.last_sign_in_at
    )
  ) as identities
  from auth.identities i
  where i.user_id = u.id
) ids on true;
-- Emails/PII: not for the public anon key, even though the columns are "safe".
revoke all on public.auth_users_safe from anon, authenticated, public;
grant select on public.auth_users_safe to service_role;
notify pgrst, 'reload schema';
