begin;

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  email text not null unique,
  password_hash text not null,
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  user_id uuid primary key references users(id) on delete cascade,
  display_name text not null default '',
  bio text not null default '',
  avatar_url text,
  cover_url text,
  pronouns text not null default '',
  website text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references users(id),
  body text not null check (char_length(body) between 1 and 10000),
  visibility text not null default 'public' check (visibility in ('public','followers')),
  reply_to_id uuid references posts(id),
  repost_of_id uuid references posts(id),
  content_warning text not null default '',
  language text not null default 'und',
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create table if not exists follows (
  follower_id uuid not null references users(id) on delete cascade,
  followed_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  check (follower_id <> followed_id)
);

create table if not exists reactions (
  actor_id uuid not null references users(id) on delete cascade,
  post_id uuid not null references posts(id) on delete cascade,
  kind text not null default 'like' check (kind = 'like'),
  created_at timestamptz not null default now(),
  primary key (actor_id, post_id, kind)
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references users(id),
  type text not null,
  object_type text not null,
  object_id uuid,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (actor_id, idempotency_key)
);

create index if not exists posts_author_created_idx on posts(author_id, created_at desc);
create index if not exists posts_reply_idx on posts(reply_to_id, created_at asc);
create index if not exists follows_followed_idx on follows(followed_id, created_at desc);
create index if not exists events_created_idx on events(created_at asc, id asc);

commit;
