-- Vitaminia — конвейер производства статей (идея → job → публикация).
-- Портировано с актуальной схемы medizin.ru (ktladyirijrqssfdjira), но
-- БЕЗ колонки content_type — у Vitaminia один тип контента (нутриент),
-- в отличие от medizin (symptom/drug). Вся логика воркера (heartbeat-локи,
-- backoff, дедлайны, auto_publish) переносится как есть — тип контента
-- никак не участвует в этой части конвейера.

create extension if not exists pgcrypto;

-- ============================================================
-- content_ideas
-- ============================================================
create table public.content_ideas (
  id            uuid primary key default gen_random_uuid(),
  working_title text not null,
  slug          text,
  category      text,
  reason        text not null check (reason in (
                  'gap_in_cluster','extend_existing','important_user_topic',
                  'replace_split_existing','technical_necessity','search_demand',
                  'editorial_idea','user_request','other'
                )),
  priority      text not null default 'medium' check (priority in ('high','medium','low')),
  status        text not null default 'idea' check (status in (
                  'idea','checked','ready','in_progress','created','rejected','archived'
                )),
  conflict_note text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  source        text not null default 'manual' check (source in ('manual','ai_strategy')),
  strategy_run_id uuid,
  priority_score integer,
  content_gap_score integer,
  competition_opportunity_score integer,
  rationale     text,
  duplicate_check_result jsonb
);

-- ============================================================
-- content_strategy_runs
-- ============================================================
create table public.content_strategy_runs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  created_by    uuid references auth.users(id),
  params        jsonb not null default '{}',
  status        text not null default 'running' check (status in (
                  'running','ready','completed','error','stopped','interrupted'
                )),
  current_stage text not null default 'context' check (current_stage in (
                  'context','history','plan','research','dedupe','prioritize','done'
                )),
  stats         jsonb not null default '{}',
  candidates    jsonb not null default '[]',
  model         text,
  usage_input_tokens integer,
  usage_output_tokens integer,
  estimated_cost_usd numeric,
  duration_ms   integer,
  error         text,
  raw_candidates jsonb,
  last_raw_response jsonb,
  last_error    text,
  active_worker_id text,
  active_worker_heartbeat_at timestamptz
);

alter table public.content_ideas
  add constraint content_ideas_strategy_run_id_fkey
  foreign key (strategy_run_id) references public.content_strategy_runs(id);

-- ============================================================
-- content_jobs
-- ============================================================
create table public.content_jobs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  content_idea_id uuid references public.content_ideas(id),
  title         text not null,
  slug          text,
  category      text,
  status        text not null default 'planned' check (status in (
                  'planned','researching','drafting','medical_review','final_review',
                  'seo_review','needs_decision','approved','validating','committing',
                  'deploying','published','validation_failed','commit_failed',
                  'deploy_failed','error','paused','rejected','archived'
                )),
  current_stage text not null default 'research' check (current_stage in (
                  'research','draft','medical_review','final_review','seo_review','done'
                )),
  research_brief jsonb,
  draft         jsonb,
  medical_review jsonb,
  seo_review    jsonb,
  decision_reason text,
  final_mdx     text,
  created_by    uuid references auth.users(id),
  fix_count     integer not null default 0 check (fix_count >= 0 and fix_count <= 3),
  budget_limit_usd numeric not null default 1.25,
  stop_reason_code text check (stop_reason_code is null or stop_reason_code in ('hard_limit','manual')),
  active_stage  text,
  active_run_started_at timestamptz,
  published_at  timestamptz,
  published_by  uuid references auth.users(id),
  publish_registry_id text,
  publish_commit_sha text,
  publish_stage_failed text,
  return_count  integer not null default 0 check (return_count >= 0 and return_count <= 20),
  deploy_checked_at timestamptz,
  deploy_check_note text,
  publish_build_check jsonb,
  publish_expected_url text,
  deploy_started_at timestamptz,
  deploy_url_live boolean,
  active_worker_id text,
  active_worker_heartbeat_at timestamptz,
  failure_kind  text check (failure_kind is null or failure_kind in ('infra_error','content_review')),
  last_retry_at timestamptz,
  next_attempt_at timestamptz,
  pending_revision_instruction text,
  editor_notes  text,
  auto_publish  boolean not null default true,
  published_build_version text
);

create index content_jobs_status_idx on public.content_jobs(status);
create index content_jobs_content_idea_id_idx on public.content_jobs(content_idea_id);

-- ============================================================
-- content_job_runs — аудит-лог AI-вызовов
-- ============================================================
create table public.content_job_runs (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.content_jobs(id),
  stage         text not null check (stage in (
                  'research','draft','medical_review','final_review','seo_review',
                  'revision','point_fix','publish'
                )),
  attempt       integer not null default 1 check (attempt >= 1),
  status        text not null check (status in ('ok','error','needs_decision')),
  input         jsonb,
  output        jsonb,
  model         text,
  usage_input_tokens integer,
  usage_output_tokens integer,
  error         text,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  duration_ms   integer,
  cost_usd      numeric
);

create index content_job_runs_job_id_idx on public.content_job_runs(job_id);

-- ============================================================
-- content_sources
-- ============================================================
create table public.content_sources (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.content_jobs(id),
  title         text not null,
  organization  text,
  url           text not null check (char_length(url) <= 2048),
  accessed_at   date not null default current_date,
  source_type   text check (source_type in (
                  'who','nhs','cdc','nih','medlineplus','nice','mayo_clinic',
                  'cleveland_clinic','professional_society','clinical_guideline',
                  'university_medical_center','other'
                )),
  supports      text
);

create index content_sources_job_id_idx on public.content_sources(job_id);

-- ============================================================
-- worker_heartbeat — таблица-синглтон
-- ============================================================
create table public.worker_heartbeat (
  id          text primary key default 'main',
  worker_id   text,
  last_seen_at timestamptz not null default now(),
  started_at  timestamptz,
  queue_size  integer,
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- RLS — все эти таблицы обслуживаются ИСКЛЮЧИТЕЛЬНО через service-role
-- ключ (SSR API-роуты /api/admin/*, воркер) — service role в Supabase
-- обходит RLS по умолчанию, поэтому "enable RLS без единой policy" —
-- это "закрыто для anon/authenticated, доступно только service role",
-- ровно та же модель, что уже действует в medizin.ru (см. pg_policies
-- там — политик для content_* тоже нет ни одной).
-- ============================================================
alter table public.content_ideas         enable row level security;
alter table public.content_strategy_runs enable row level security;
alter table public.content_jobs          enable row level security;
alter table public.content_job_runs      enable row level security;
alter table public.content_sources       enable row level security;
alter table public.worker_heartbeat      enable row level security;

-- updated_at авто-обновление (тот же паттерн, что в 001_my_card.sql medizin)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at_content_ideas
  before update on public.content_ideas
  for each row execute function public.set_updated_at();

create trigger set_updated_at_content_jobs
  before update on public.content_jobs
  for each row execute function public.set_updated_at();

create trigger set_updated_at_content_strategy_runs
  before update on public.content_strategy_runs
  for each row execute function public.set_updated_at();

create trigger set_updated_at_worker_heartbeat
  before update on public.worker_heartbeat
  for each row execute function public.set_updated_at();
