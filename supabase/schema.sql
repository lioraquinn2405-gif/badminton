-- Chạy file này trong Supabase: SQL Editor -> New query -> dán -> Run

create table if not exists settings (
  id int primary key default 1,
  default_courts jsonb
);

create table if not exists weeks (
  key text primary key,            -- ngày Thứ 2 của tuần, dạng YYYY-MM-DD
  courts jsonb,
  schedule jsonb
);

create table if not exists registrations (
  week_key text not null,
  name text not null,
  username text,
  days jsonb not null,
  min_sessions int not null default 2,
  at text,
  primary key (week_key, name)
);

create table if not exists app_users (
  username text primary key,
  name text not null,
  salt text not null,
  hash text not null,
  role text not null default 'member',
  status text not null default 'pending',
  created_at text
);
create unique index if not exists app_users_name_ci on app_users (lower(name));

create table if not exists sessions (
  token_hash text primary key,
  username text not null,
  exp bigint not null
);

create table if not exists login_fails (
  key text primary key,
  n int not null,
  t bigint not null
);

-- Bật RLS và KHÔNG tạo policy: khóa truy cập từ trình duyệt/anon key.
-- Chỉ server (service-role key) mới đọc ghi được.
alter table settings enable row level security;
alter table weeks enable row level security;
alter table registrations enable row level security;
alter table app_users enable row level security;
alter table sessions enable row level security;
alter table login_fails enable row level security;
