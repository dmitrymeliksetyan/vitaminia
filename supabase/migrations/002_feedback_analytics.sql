-- Vitaminia — обратная связь + минимальная аналитика (портировано с medizin.ru).
-- analytics_events.event_name сокращён: у Vitaminia нет /my (карта/дневники)
-- и Помощника — из исходного enum убраны card_*/assistant_*/journal_*.

create table public.feedback_messages (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  user_id       uuid references auth.users(id),
  user_email    text,
  reply_email   text check (reply_email is null or char_length(reply_email) <= 254),
  name          text check (name is null or char_length(name) <= 100),
  message       text not null check (char_length(message) >= 3 and char_length(message) <= 5000),
  page_url      text check (page_url is null or char_length(page_url) <= 2048),
  user_agent    text check (user_agent is null or char_length(user_agent) <= 512),
  status        text not null default 'new' check (status in ('new','read','replied','archived')),
  email_notification_sent boolean not null default false,
  email_notification_error text
);

create table public.analytics_events (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  event_name    text not null check (event_name in ('page_view','signup_started','signup_completed')),
  user_id       uuid references auth.users(id),
  anonymous_id  uuid,
  session_id    uuid,
  page_path     text check (page_path is null or char_length(page_path) <= 512),
  metadata      jsonb not null default '{}' check (pg_column_size(metadata) <= 2000)
);

create index analytics_events_created_at_idx on public.analytics_events(created_at desc);

alter table public.feedback_messages enable row level security;
alter table public.analytics_events  enable row level security;
