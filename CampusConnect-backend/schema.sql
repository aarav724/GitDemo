create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'student' check (role in ('student', 'organizer', 'admin')),
  display_name text,
  course text,
  bio text,
  avatar_url text,
  website_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  club_id uuid,
  title text not null check (char_length(title) between 3 and 120),
  description text not null check (char_length(description) between 10 and 2000),
  event_date timestamptz, location text, image_url text, video_url text,
  poster_url text, start_time timestamptz, end_time timestamptz,
  venue text, category text, max_team_size integer check (max_team_size is null or max_team_size > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 120),
  club_name text, description text, logo_url text, category text, cover_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.club_posts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  content text, media_url text, media_type text,
  created_at timestamptz not null default now(),
  check (content is not null or media_url is not null)
);
create table if not exists public.club_followers (
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (club_id, user_id)
);
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.club_posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 1000),
  created_at timestamptz not null default now()
);
create table if not exists public.event_participants (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('going', 'interested')),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create table if not exists public.bookmarks (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create table if not exists public.teammate_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  title text not null, description text not null, skills text, active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.teammate_requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.teammate_listings(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (listing_id, requester_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists events_created_at_idx on public.events(created_at desc);
create index if not exists events_date_idx on public.events(event_date);
create index if not exists club_posts_club_idx on public.club_posts(club_id, created_at desc);
create index if not exists teammates_active_idx on public.teammate_listings(active, created_at desc);

-- Safe migrations for databases created from an older version of this schema.
alter table public.events add column if not exists club_id uuid references public.clubs(id) on delete set null;
alter table public.events add column if not exists poster_url text;
alter table public.events add column if not exists start_time timestamptz;
alter table public.events add column if not exists end_time timestamptz;
alter table public.events add column if not exists venue text;
alter table public.events add column if not exists category text;
alter table public.events add column if not exists max_team_size integer;
alter table public.clubs add column if not exists club_name text;
alter table public.clubs add column if not exists category text;
update public.clubs set club_name = name where club_name is null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_club_id_fkey') then
    alter table public.events add constraint events_club_id_fkey foreign key (club_id) references public.clubs(id) on delete set null;
  end if;
end $$;
create index if not exists events_start_time_idx on public.events(start_time);
create index if not exists events_category_idx on public.events(category);
create index if not exists events_club_idx on public.events(club_id);
create index if not exists teammates_event_idx on public.teammate_listings(event_id, active, created_at desc);
create index if not exists teammate_requests_requester_idx on public.teammate_requests(requester_id, created_at desc);
create index if not exists teammate_requests_listing_idx on public.teammate_requests(listing_id, created_at desc);
create index if not exists messages_recipient_idx on public.messages(recipient_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.clubs enable row level security;
alter table public.club_posts enable row level security;
alter table public.club_followers enable row level security;
alter table public.comments enable row level security;
alter table public.event_participants enable row level security;
alter table public.bookmarks enable row level security;
alter table public.teammate_listings enable row level security;
alter table public.teammate_requests enable row level security;
alter table public.messages enable row level security;

-- The API uses the service role after validating the user's access token.
-- These policies also make direct anon-key reads safe for public content.
drop policy if exists public_read_events on public.events;
create policy public_read_events on public.events for select using (true);
drop policy if exists public_read_profiles on public.profiles;
create policy public_read_profiles on public.profiles for select using (true);
drop policy if exists public_read_clubs on public.clubs;
create policy public_read_clubs on public.clubs for select using (true);
drop policy if exists public_read_posts on public.club_posts;
create policy public_read_posts on public.club_posts for select using (true);
drop policy if exists public_read_comments on public.comments;
create policy public_read_comments on public.comments for select using (true);
drop policy if exists public_read_teammates on public.teammate_listings;
create policy public_read_teammates on public.teammate_listings for select using (active = true);

insert into storage.buckets (id, name, public)
values ('club-media', 'club-media', false)
on conflict (id) do nothing;
