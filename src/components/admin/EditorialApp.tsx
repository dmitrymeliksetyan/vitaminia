import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/auth/browser-supabase";
import AdminNav from "./AdminNav";
import { computeJobOutcome, OUTCOME_LABELS, OUTCOME_COLORS, summarizeOutcome } from "../../lib/content-editor/job-outcome";

// Идея активна (не завершилась/не отклонена/не в архиве) — раньше жила в
// lib/content-registry/clusters.mjs вместе с кластерным анализом, который
// Vitaminia не переносит (упрощённая, однотипная админка); сама функция
// не имеет отношения к кластерам, поэтому просто inline здесь.
function isActiveIdea(idea: any): boolean {
  return idea.status !== "created" && idea.status !== "rejected" && idea.status !== "archived";
}
import { Centered, LinkStat, Select, TabButton, fmtCost, fmtDateShort, fmtDurationShort, fmtTime, tierStars, computeJobCostSummary, RefreshingHint, RetryBanner } from "./dashboard-shared";
import { searchRegistry, slugify } from "vitaminia-shared/content-registry/search.mjs";
import { hasRecentAdminOk, markAdminOk, clearAdminSessionCache, getCachedData, setCachedData } from "../../lib/admin/client-session-cache";
import { humanizeError } from "../../lib/content-editor/humanize-error";

// ТЗ "Убрать повторную проверку доступа и Load failed" — см.
// src/lib/admin/client-session-cache.ts для полного объяснения. Кратко:
// AI-редакция — одна из 7 admin-страниц, переход на которую (как и между
// её собственными вкладками "Обзор"/"AI-стратег"/"Контент-план"/
// "Производство"/"Архив" — все они реализованы как отдельные Astro-
// страницы через EditorialSubNav ниже, обычные <a href>!) — полная
// перезагрузка браузера. Данные хаба (registry/ideas/jobs/strategy runs)
// одинаковы для ЛЮБОЙ вкладки (section — это просто то, что показать, а не
// то, что запросить) — поэтому кэшируются под ОДНИМ ключом, общим для всех
// пяти вкладок сразу.
const EDITORIAL_HUB_CACHE_KEY = "editorial-hub";
interface EditorialHubCache {
  items: any[];
  ideas: any[];
  jobs: any[];
  strategyRuns: any[];
  strategyLatestCandidates: any[] | null;
}

// Этап 7 ТЗ — «AI-редакция» как отдельная страница верхнего уровня
// (/admin/editorial и вложенные /strategy, /plan, /jobs, /jobs/[id],
// /archive), а не часть общей страницы «Контент» (см. финальный отчёт
// Этапа 6, которая объединяла производство и библиотеку на одном экране).
// Ничего из бизнес-логики не поменялось — весь фетчинг/мемо-логика
// перенесены сюда почти без изменений из старого ContentDashboard.tsx,
// поменялась только маршрутизация (реальные Astro-страницы вместо
// useState-вкладок) — деталь важна для deep links (п.10 ТЗ): обновление
// страницы и прямая ссылка теперь работают нативно на уровне сервера, а не
// поверх ручного pushState/popstate.

export type EditorialSection = "overview" | "strategy" | "plan" | "jobs" | "archive";

const REASON_LABELS: Record<string, string> = {
  gap_in_cluster: "Пробел в кластере",
  search_demand: "Поисковый спрос",
  editorial_idea: "Редакционная идея",
  user_request: "Пользовательский запрос",
  extend_existing: "Расширение существующей темы",
  other: "Другое",
  important_user_topic: "Важная пользовательская тема",
  replace_split_existing: "Замена/разделение существующего материала",
  technical_necessity: "Техническая необходимость",
};
const NEW_REASON_OPTIONS = ["gap_in_cluster", "search_demand", "editorial_idea", "user_request", "extend_existing", "other"];
const PRIORITY_LABELS: Record<string, string> = { high: "Высокий", medium: "Средний", low: "Низкий" };
const IDEA_STATUS_LABELS: Record<string, string> = {
  idea: "Идея",
  checked: "Проверена",
  ready: "Готова к созданию",
  in_progress: "В работе",
  created: "Опубликована",
  rejected: "Отклонена",
  archived: "Архивирована",
};
// validation_failed/commit_failed добавлены рядом с deploy_failed (новое ТЗ
// п.6) — та же логика: производство фактически завершено ("done"), просто
// последний шаг публикации не удался, поэтому job одновременно показывается
// и в архиве/Библиотеке (это уже готовый материал, ждущий republish), и в
// jobsProblem на хабе (требует внимания) — то же двойное отображение, что
// уже было у deploy_failed.
const EDITORIAL_ARCHIVE_STATUSES = new Set([
  "published", "deploying", "deploy_failed", "validation_failed", "commit_failed", "approved", "rejected", "archived",
]);

const IDEA_PRIORITY_COLOR: Record<string, string> = {
  high: "var(--color-severity-high)",
  medium: "var(--color-severity-medium)",
  low: "var(--color-text-secondary)",
};

const TOPIC_COUNT_OPTIONS = [10, 20, 30, 50];
const STRATEGY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "max_traffic", label: "Максимальный потенциальный трафик" },
  { value: "fill_gaps", label: "Закрыть пробелы сайта" },
  { value: "strengthen_cluster", label: "Усилить конкретный кластер" },
  { value: "seasonal", label: "Сезонные темы" },
];

const STRATEGY_PROGRESS_STEPS = [
  "Анализируем опубликованные симптомы",
  "Проверяем историю объединённых и удалённых тем",
  "Анализируем существующий контент-план",
  "Ищем пробелы и пользовательские запросы",
  "Проверяем кандидатов на дубли",
  "Расставляем приоритеты",
];

// ТЗ "AI Strategy упрощена" — demandTier/searchIntent/relatedContentTitles
// больше не приходят от AI (см. strategy-dedupe.ts::ScoredCandidate) и
// DEMAND_TIER_LABELS больше нигде не используется — карточка кандидата ниже
// показывает только то, что реально считает код (priority/priorityScore/
// duplicateCheckResult/rationale).

const TIER_STARS_LABEL: Record<string, string> = {
  "★★★★★": "— наивысший приоритет",
  "★★★★": "— высокий приоритет",
  "★★★": "— стоит рассмотреть",
};

// Те же SLA-таргеты, что в production-config.ts (STAGE_TARGET_MS) — только
// для UI-предупреждения "дольше ожидаемого" (п.14 ТЗ), не влияют ни на
// какой сетевой таймаут. Продублировано намеренно: клиентский бандл не
// должен тянуть серверный модуль ai-client.ts.
const STAGE_TARGET_MS_CLIENT: Record<string, number> = {
  research: 3 * 60_000,
  draft: 2 * 60_000,
  medical_review: 5 * 60_000,
  seo_review: 5_000,
};

const PIPELINE_STEPS_INFO: Array<{ icon: string; label: string }> = [
  { icon: "🔎", label: "Исследование" },
  { icon: "🧭", label: "Стратегия" },
  { icon: "✍️", label: "Автор" },
  { icon: "⚕️", label: "Медпроверка" },
  { icon: "✓", label: "Готово" },
];

const HUB_PRIMARY_BTN: React.CSSProperties = {
  fontSize: "var(--font-size-xs)",
  fontWeight: "var(--font-weight-medium)",
  padding: "7px 14px",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-brand-blue)",
  color: "#fff",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const HUB_SECONDARY_BTN: React.CSSProperties = {
  fontSize: "var(--font-size-xs)",
  padding: "7px 14px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-border)",
  background: "#fff",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const JOB_STAGE_STEPS: Array<{ key: string; label: string }> = [
  { key: "research", label: "Исследуется" },
  { key: "draft", label: "Пишется" },
  { key: "medical_review", label: "Проверяется" },
  { key: "final_review", label: "Финализируется" },
  { key: "seo_review", label: "Финализируется" },
  { key: "done", label: "Готово" },
];

// ТЗ п.4 "Единый Pipeline" — под-конвейер публикации (см. комментарий у места
// использования в JobScreen). Порядок статусов внутри каждого шага важен для
// PUBLISH_SUBSTEPS.findIndex(...includes(job.status)) — used как "текущий шаг".
const PUBLISH_SUBSTEPS: Array<{ label: string; statuses: string[] }> = [
  { label: "Проверка", statuses: ["validating", "validation_failed"] },
  { label: "Коммит в GitHub", statuses: ["committing", "commit_failed"] },
  { label: "Сборка сайта", statuses: ["deploying", "deploy_failed"] },
  { label: "Опубликовано", statuses: ["published"] },
];

const JOB_STATUS_LABELS: Record<string, string> = {
  planned: "Запланировано",
  researching: "Исследование",
  drafting: "Черновик",
  medical_review: "Медицинская проверка",
  final_review: "Финальная проверка",
  seo_review: "Проверка структуры и SEO",
  needs_decision: "Требует решения",
  approved: "Готово к публикации",
  // Новые переходные статусы публикации (упрощение AI-стратега, ТЗ п.6) —
  // строго ДО коммита в GitHub, поэтому явно отличаются от deploying/published.
  validating: "Проверка перед публикацией",
  committing: "Публикуется — коммит в GitHub",
  deploying: "Ожидается сборка сайта",
  published: "Опубликовано",
  validation_failed: "Не прошла проверку перед публикацией",
  commit_failed: "Ошибка коммита в GitHub",
  deploy_failed: "Ошибка сборки/деплоя",
  error: "Ошибка",
  paused: "Приостановлено",
  rejected: "Отклонено",
  archived: "Архив",
};

const ADVANCEABLE_JOB_STATUSES = new Set(["planned", "researching", "drafting", "medical_review", "final_review", "seo_review"]);

const STAGE_RUN_LABELS: Record<string, string> = {
  research: "Исследование",
  draft: "Черновик",
  medical_review: "Медицинская проверка и автоправка",
  final_review: "Финальная проверка исправлений",
  point_fix: "Точечная правка (устар.)",
  seo_review: "SEO-проверка",
  revision: "Доработка по заданию",
  publish: "Финальная публикация",
};

// ТЗ "Editorial Engine 2.0", п.6 "Очередь как диспетчер производства" —
// "должны быть чёткие статусы: Running / Waiting / Paused / Retry / Failed /
// Completed" + "должна отображаться причина остановки". Раньше в UI были
// только "сырые" content_jobs.status (см. JOB_STATUS_LABELS выше) — эта
// функция НЕ заменяет их (полный статус по-прежнему виден на карточке
// материала), а даёт более грубую, но однозначную классификацию поверх уже
// существующих полей (active_stage/failure_kind/next_attempt_at — миграция
// 016; status — таблица content_jobs с самого начала), специально для
// списков в разделе "Производство".
type DispatcherState = "running" | "waiting" | "paused" | "retry" | "failed" | "completed";
const DISPATCHER_STATE_LABELS: Record<DispatcherState, string> = {
  running: "Выполняется",
  waiting: "Ожидает",
  paused: "Приостановлено",
  retry: "Ожидает повтора",
  failed: "Остановлено (ошибка)",
  completed: "Завершено",
};
const DISPATCHER_STATE_COLORS: Record<DispatcherState, string> = {
  running: "var(--color-brand-blue)",
  waiting: "var(--color-text-secondary)",
  paused: "var(--color-severity-medium, #b8860b)",
  retry: "var(--color-severity-medium, #b8860b)",
  failed: "var(--color-brand-red)",
  completed: "var(--color-severity-low)",
};
const FAILED_STATUSES = new Set(["error", "deploy_failed", "validation_failed", "commit_failed"]);
function computeDispatcherState(j: any): DispatcherState {
  if (j.status === "published") return "completed";
  if (j.status === "paused") return "paused";
  if (FAILED_STATUSES.has(j.status)) {
    // failure_kind='infra_error' с уже назначенным next_attempt_at — это
    // именно "Retry" (воркер сам попробует снова), а не тупик, требующий
    // решения человека (тот случай остаётся "Failed").
    if (j.failure_kind === "infra_error" && j.next_attempt_at) return "retry";
    return "failed";
  }
  if (j.status === "needs_decision") return "waiting";
  // Активная стадия занята конкретным воркером прямо сейчас — Running;
  // иначе job просто ждёт своей очереди на подхват (Waiting).
  return j.active_stage ? "running" : "waiting";
}
// Причина остановки/ожидания рядом со статусом — decision_reason пишет
// сервер при каждом переходе в needs_decision/failed/paused (см. advance.ts /
// queue-loop.ts в medizin-worker); гуманизируем тем же словарём, что и
// сырые content_job_runs.error, т.к. смысл сообщений пересекается.
function dispatcherStopReason(j: any): string | null {
  if (j.decision_reason) return humanizeError(j.decision_reason).summary;
  return null;
}

// ТЗ "AI-стратег всё ещё не завершает run — диагностика" (п.2) — отдельная
// карта именно для content_strategy_runs.current_stage (context/research/
// dedupe/history/prioritize/plan/done), т.к. STAGE_RUN_LABELS выше — про
// content_jobs (research/draft/medical_review/...), почти не пересекается.
const STRATEGY_STAGE_LABELS: Record<string, string> = {
  context: "Сбор контекста сайта",
  research: "AI-поиск кандидатов",
  dedupe: "Проверка на дубли",
  history: "Проверка по истории",
  prioritize: "Расчёт приоритета",
  plan: "Сохранение контент-плана",
  done: "Готово",
};

// ТЗ п.2 (дословно): вместо общего "Исследование выполняется (или
// остановилось...)" — точное состояние. Порядок проверок специально такой:
// interrupted/error — самые информативные (есть last_error/точный этап);
// затем running с уже полученными raw_candidates — это отдельное, более
// специфичное состояние ("кандидаты уже есть, дальше только синхронный код"),
// чем просто "выполняется AI-поиск".
function describeStrategyRunState(run: any): string {
  if (run.status === "interrupted") return `Прервано на этапе: ${run.current_stage}`;
  if (run.status === "error" || run.status === "stopped") return `Ошибка: ${run.last_error ?? run.error ?? "неизвестная ошибка"}`;
  if (run.status === "running") {
    const rawCount = Array.isArray(run.raw_candidates) ? run.raw_candidates.length : 0;
    if (rawCount > 0) return "Кандидаты получены, формируем план";
    if (run.current_stage === "research") return "Выполняется: AI-поиск кандидатов";
    return `Выполняется: ${STRATEGY_STAGE_LABELS[run.current_stage] ?? run.current_stage}`;
  }
  return STRATEGY_STAGE_LABELS[run.current_stage] ?? run.current_stage;
}

// ТЗ п.1 (дословно) — диагностический блок для последнего run'а: run_id,
// status, current_stage, last_error, started_at, updated_at,
// raw_candidates.length, stats. Показывается всегда, когда run загружен —
// это единственный способ по скриншоту сразу понять реальное состояние
// backend'а, не дожидаясь ответа поддержки.
function StrategyRunDiagnostics({ run }: { run: any }) {
  const rawCount = Array.isArray(run.raw_candidates) ? run.raw_candidates.length : 0;
  const rows: Array<[string, string]> = [
    ["run_id", run.id],
    ["status", run.status],
    ["current_stage", run.current_stage],
    ["last_error", run.last_error ?? run.error ?? "—"],
    ["started_at", run.created_at],
    ["updated_at", run.updated_at],
    ["raw_candidates.length", String(rawCount)],
    ["stats", JSON.stringify(run.stats ?? {})],
  ];
  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        background: "var(--color-neutral-100)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        fontSize: "11px",
        fontFamily: "monospace",
        color: "var(--color-text-secondary)",
        lineHeight: 1.7,
        wordBreak: "break-word",
      }}
    >
      <div style={{ fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)", marginBottom: 4, fontFamily: "inherit" }}>
        Диагностика run'а
      </div>
      {rows.map(([label, value]) => (
        <div key={label}>
          {label}: {value}
        </div>
      ))}
    </div>
  );
}

export default function EditorialApp({ section, jobId }: { section: EditorialSection; jobId?: string | null }) {
  const cachedHub = getCachedData<EditorialHubCache>(EDITORIAL_HUB_CACHE_KEY);
  const [phase, setPhase] = useState<"checking" | "loading" | "unauthorized" | "forbidden" | "ready" | "error">(
    cachedHub ? "ready" : hasRecentAdminOk() ? "loading" : "checking"
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [items, setItems] = useState<any[]>(cachedHub?.items ?? []);
  const [ideas, setIdeas] = useState<any[]>(cachedHub?.ideas ?? []);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [jobs, setJobs] = useState<any[]>(cachedHub?.jobs ?? []);
  const [strategyRuns, setStrategyRuns] = useState<any[]>(cachedHub?.strategyRuns ?? []);
  const [strategyLatestCandidates, setStrategyLatestCandidates] = useState<any[] | null>(cachedHub?.strategyLatestCandidates ?? null);

  const [queueCategoryFilter, setQueueCategoryFilter] = useState("all");
  const [openJobId, setOpenJobId] = useState<string | null>(jobId ?? null);

  // ТЗ "Editorial Engine 2.0", п.8 "Массовые операции" — набор выбранных
  // job'ов в разделе "Производство" + состояние запроса к /jobs/bulk.
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResultMsg, setBulkResultMsg] = useState<string | null>(null);
  const toggleJobSelected = React.useCallback((id: string) => {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const runBulkAction = React.useCallback(async (action: "retry" | "publish" | "archive") => {
    if (!accessToken || selectedJobIds.size === 0) return;
    setBulkBusy(true);
    setBulkResultMsg(null);
    try {
      const res = await fetch("/api/admin/content/jobs/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action, ids: Array.from(selectedJobIds) }),
      });
      const json = await res.json();
      if (json.ok) {
        setBulkResultMsg(`Готово: ${json.succeeded} из ${json.succeeded + json.failed} выполнено успешно.`);
        setSelectedJobIds(new Set());
        refreshHub(accessToken);
      } else {
        setBulkResultMsg(json.error ?? "Не удалось выполнить массовое действие");
      }
    } catch {
      setBulkResultMsg("Ошибка сети при выполнении массового действия");
    } finally {
      setBulkBusy(false);
    }
  }, [accessToken, selectedJobIds]);

  // ТЗ "Editorial Engine 2.0", п.5 — "Worker offline" должен быть видимой
  // ошибкой, а не молчаливой остановкой (см. worker-status.ts + миграция
  // 018, worker_heartbeat). Не кэшируется в EditorialHubCache сознательно —
  // это живой статус процесса, показывать устаревшее значение из
  // sessionStorage было бы хуже, чем не показывать вообще.
  const [workerStatus, setWorkerStatus] = useState<{ online: boolean; reason: string | null; lastSeenAt: string | null } | null>(null);
  const loadWorkerStatus = React.useCallback(async (token: string) => {
    try {
      const res = await fetch("/api/admin/content/worker-status", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (json.ok) setWorkerStatus({ online: json.online, reason: json.reason, lastSeenAt: json.lastSeenAt });
    } catch {
      /* не критично — просто не покажем баннер статуса воркера в этот раз */
    }
  }, []);

  const loadIdeas = React.useCallback(async (token: string) => {
    setIdeasLoading(true);
    try {
      const res = await fetch("/api/admin/content/ideas", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (json.ok) setIdeas(json.items ?? []);
    } catch {
      /* не критично для остальной страницы */
    } finally {
      setIdeasLoading(false);
    }
  }, []);

  const loadJobs = React.useCallback(async (token: string) => {
    try {
      const res = await fetch("/api/admin/content/jobs", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (json.ok) setJobs(json.items ?? []);
    } catch {
      /* не критично для остальной страницы */
    }
  }, []);

  const loadStrategyRuns = React.useCallback(async (token: string) => {
    try {
      const res = await fetch("/api/admin/content/strategy/runs", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!json.ok) return;
      const runsItems = json.items ?? [];
      setStrategyRuns(runsItems);
      const latest = runsItems[0];
      if (latest && (latest.status === "ready" || latest.status === "completed")) {
        const detailRes = await fetch(`/api/admin/content/strategy/runs/${latest.id}`, { headers: { Authorization: `Bearer ${token}` } });
        const detailJson = await detailRes.json();
        if (detailJson.ok) setStrategyLatestCandidates(detailJson.run?.candidates ?? []);
      } else {
        setStrategyLatestCandidates(null);
      }
    } catch {
      /* не критично для остальной страницы */
    }
  }, []);

  const refreshHub = React.useCallback(
    (token: string) => {
      loadIdeas(token);
      loadJobs(token);
      loadStrategyRuns(token);
      loadWorkerStatus(token);
    },
    [loadIdeas, loadJobs, loadStrategyRuns, loadWorkerStatus]
  );

  // Статус воркера перепроверяется, пока открыта страница (раз в 30с) —
  // иначе редактор мог бы смотреть на "воркер жив", открыв вкладку до того,
  // как воркер реально упал.
  useEffect(() => {
    if (!accessToken) return;
    const timer = setInterval(() => loadWorkerStatus(accessToken), 30_000);
    return () => clearInterval(timer);
  }, [accessToken, loadWorkerStatus]);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedData<EditorialHubCache>(EDITORIAL_HUB_CACHE_KEY);
    if (cached) {
      setPhase("ready");
      setRefreshing(true);
    } else {
      setPhase(hasRecentAdminOk() ? "loading" : "checking");
    }

    async function load() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session) {
        clearAdminSessionCache();
        setPhase("unauthorized");
        return;
      }
      // Infra v2, п.11-12 ТЗ ("ускорить админку/AI-редакцию") — раньше три
      // запроса хаба (ideas/jobs/strategy runs) стартовали ТОЛЬКО после
      // того, как резолвился /registry (await, потом refreshHub) — то есть
      // фактически ждали его целиком, хотя ни один из них не зависит от
      // ответа /registry (все используют один и тот же access-токен).
      // Запускаем хаб одновременно с /registry, а не после него — время до
      // первого полезного рендера теперь ограничено самым медленным из
      // четырёх параллельных запросов, а не их суммой.
      setAccessToken(session.access_token);
      refreshHub(session.access_token);
      try {
        const res = await fetch("/api/admin/content/registry", { headers: { Authorization: `Bearer ${session.access_token}` } });
        if (cancelled) return;
        if (res.status === 401) {
          clearAdminSessionCache();
          return setPhase("unauthorized");
        }
        if (res.status === 403) {
          clearAdminSessionCache();
          return setPhase("forbidden");
        }
        const json = await res.json();
        if (!json.ok) {
          console.warn("[admin/editorial] registry вернул ok:false —", json.error);
          if (cached) setLoadError(json.error);
          else {
            setErrorMessage(json.error);
            setPhase("error");
          }
          return;
        }
        markAdminOk();
        setItems(json.items);
        setPhase("ready");
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Не удалось загрузить данные";
        // Диагностика без раскрытия секретов — виден именно упавший запрос
        // (/api/admin/content/registry) и причина, включая "Load failed".
        console.warn("[admin/editorial] registry fetch завершился ошибкой:", err);
        if (cached) setLoadError(msg);
        else {
          setErrorMessage(msg);
          setPhase("error");
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [refreshHub, reloadTick]);

  // Персистируем хаб в sessionStorage при ЛЮБОМ изменении его данных (а не
  // только сразу после /registry) — loadIdeas/loadJobs/loadStrategyRuns
  // резолвятся асинхронно и независимо, поэтому кэш должен обновляться по
  // мере того, как каждый из них реально приходит, а не один раз в момент
  // загрузки страницы.
  useEffect(() => {
    if (phase !== "ready") return;
    setCachedData<EditorialHubCache>(EDITORIAL_HUB_CACHE_KEY, { items, ideas, jobs, strategyRuns, strategyLatestCandidates });
  }, [phase, items, ideas, jobs, strategyRuns, strategyLatestCandidates]);

  const liveItems = useMemo(() => items.filter((i) => !i.retired), [items]);
  const publishedSymptoms = useMemo(() => liveItems.filter((i) => i.contentType === "nutrient" && i.status !== "draft"), [liveItems]);
  const categories = useMemo(() => liveItems.filter((i) => i.contentType === "nutrient_category"), [liveItems]);
  const categoryTitleBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.slug, c.title);
    return m;
  }, [categories]);

  const activeIdeas = useMemo(() => ideas.filter(isActiveIdea), [ideas]);

  const jobsActive = useMemo(() => jobs.filter((j: any) => ADVANCEABLE_JOB_STATUSES.has(j.status)), [jobs]);
  const jobsAwaitingDecision = useMemo(() => jobs.filter((j: any) => j.status === "needs_decision" || j.status === "paused"), [jobs]);
  const jobsReadyToApprove = useMemo(() => jobs.filter((j: any) => j.status === "needs_decision" && j.current_stage === "done"), [jobs]);
  const jobsArchive = useMemo(() => jobs.filter((j: any) => EDITORIAL_ARCHIVE_STATUSES.has(j.status)), [jobs]);
  const jobsInWork = useMemo(() => jobs.filter((j: any) => !EDITORIAL_ARCHIVE_STATUSES.has(j.status)), [jobs]);
  const jobsProblem = useMemo(
    () =>
      jobs
        .filter(
          (j: any) =>
            j.status === "error" ||
            j.status === "paused" ||
            j.status === "deploy_failed" ||
            j.status === "validation_failed" ||
            j.status === "commit_failed" ||
            (j.status === "needs_decision" && j.current_stage !== "done")
        )
        .sort((a: any, b: any) => {
          const rank = (j: any) =>
            j.status === "error" ? 0 : j.status === "deploy_failed" || j.status === "validation_failed" || j.status === "commit_failed" ? 1 : j.status === "paused" ? 2 : 3;
          return rank(a) - rank(b) || (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
        }),
    [jobs]
  );
  const jobsWorkingOnly = useMemo(() => {
    const problemIds = new Set(jobsProblem.map((j: any) => j.id));
    return jobsInWork.filter((j: any) => !problemIds.has(j.id));
  }, [jobsInWork, jobsProblem]);
  // "Опубликовано" (Часть 5 ТЗ) — теперь строго status==='published' (честная
  // публикация, Часть 13): 'deploying'/'deploy_failed' больше НЕ считаются
  // опубликованными (раньше и approved, и published смешивались в "Готово").
  const jobsPublishedTotal = useMemo(() => jobs.filter((j: any) => j.status === "published").length, [jobs]);
  const jobsPublishedToday = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return jobs.filter((j: any) => {
      if (j.status !== "published") return false;
      const updated = j.updated_at ? new Date(j.updated_at) : null;
      return !!updated && updated >= startOfDay;
    }).length;
  }, [jobs]);

  // ТЗ "Editorial Engine 2.0", п.9 "Dashboard" — метрики, которых раньше не
  // было отдельно (см. аудит: "errors"/"awaiting validation"/"stalled" были
  // слиты в один общий "Требуют решения"). Разделяем здесь, ничего не убирая
  // из уже существующего jobsProblem (он по-прежнему используется как есть
  // для списка "Производство").
  const jobsErrorOnly = useMemo(() => jobs.filter((j: any) => j.status === "error"), [jobs]);
  const jobsStalledOnly = useMemo(() => jobs.filter((j: any) => j.status === "paused"), [jobs]);
  const jobsAwaitingValidation = useMemo(
    () => jobs.filter((j: any) => j.status === "needs_decision" && j.current_stage !== "done"),
    [jobs]
  );
  const jobsAwaitingPublication = useMemo(
    () => jobs.filter((j: any) => j.status === "needs_decision" && j.current_stage === "done"),
    [jobs]
  );
  // "Последние" ленты (п.9 ТЗ) — по 5 штук, отсортировано по updated_at.
  const recentPublications = useMemo(
    () =>
      jobs
        .filter((j: any) => j.status === "published")
        .slice()
        .sort((a: any, b: any) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
        .slice(0, 5),
    [jobs]
  );
  const recentStops = useMemo(
    () =>
      jobs
        .filter((j: any) => j.status === "error" || j.status === "paused" || j.status === "deploy_failed" || j.status === "validation_failed" || j.status === "commit_failed")
        .slice()
        .sort((a: any, b: any) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
        .slice(0, 5),
    [jobs]
  );

  const latestStrategyRun = strategyRuns[0] ?? null;
  // Критические исправления AI-редакции (п.1, п.7 ТЗ) — раньше hub-виджет
  // показывал "Последнее исследование: ... найдено N тем" для ЛЮБОГО
  // последнего run'а, включая незавершённые/упавшие/зависшие в 'running' —
  // отсюда буквальный баг из ТЗ "найдено 0 тем" для неуспешного прогона.
  // Теперь сводка строится ТОЛЬКО по последнему УСПЕШНОМУ run'у; если такого
  // нет вообще — честно "Последнее успешное исследование отсутствует",
  // а не нулевой результат несуществующего анализа.
  const latestSuccessfulStrategyRun = useMemo(
    () => strategyRuns.find((r: any) => r.status === "ready" || r.status === "completed") ?? null,
    [strategyRuns]
  );
  // Если самый последний прогон вообще не тот же, что последний успешный —
  // значит есть более новая незавершённая/упавшая попытка, о которой тоже
  // стоит сообщить (иначе администратор не узнает, что "Продолжить" ждёт).
  const hasNewerUnfinishedStrategyRun = Boolean(
    latestStrategyRun && latestStrategyRun.id !== latestSuccessfulStrategyRun?.id && latestStrategyRun.status !== "ready" && latestStrategyRun.status !== "completed"
  );
  const strategyIdeas = useMemo(() => ideas.filter((i: any) => i.source === "ai_strategy"), [ideas]);
  const strategyIdeasAccepted = useMemo(() => strategyIdeas.filter((i: any) => i.status !== "rejected" && i.status !== "archived").length, [strategyIdeas]);
  const strategyIdeasRejected = useMemo(() => strategyIdeas.filter((i: any) => i.status === "rejected" || i.status === "archived").length, [strategyIdeas]);
  const strategyHighPriorityUnreviewed = useMemo(
    () => (strategyLatestCandidates ?? []).filter((c: any) => c.priority === "P0" || c.priority === "P1").length,
    [strategyLatestCandidates]
  );

  const jobsWithRunData = useMemo(() => jobs.filter((j: any) => (j.run_stats?.totalCalls ?? 0) > 0), [jobs]);
  const portfolioStats = useMemo(() => {
    const finished = jobs.filter((j: any) => j.status === "approved" || j.status === "published" || j.status === "needs_decision");
    const withData = finished.filter((j: any) => (j.run_stats?.totalCalls ?? 0) > 0);
    if (withData.length < 3) return null;
    const totalCost = withData.reduce((s: number, j: any) => s + (j.run_stats?.totalCostUsd ?? 0), 0);
    const totalDuration = withData.reduce((s: number, j: any) => s + (j.run_stats?.totalDurationMs ?? 0), 0);
    return { count: withData.length, avgCostUsd: totalCost / withData.length, avgDurationMs: totalDuration / withData.length };
  }, [jobs]);

  function sumCostSince(cutoffMs: number): number {
    return jobsWithRunData.reduce((sum: number, j: any) => {
      const updated = j.updated_at ? new Date(j.updated_at).getTime() : 0;
      if (updated < cutoffMs) return sum;
      return sum + (j.run_stats?.totalCostUsd ?? 0);
    }, 0);
  }
  const spendToday = useMemo(() => sumCostSince(new Date(new Date().setHours(0, 0, 0, 0)).getTime()), [jobsWithRunData]);
  const spend7d = useMemo(() => sumCostSince(Date.now() - 7 * 24 * 60 * 60 * 1000), [jobsWithRunData]);
  const spend30d = useMemo(() => sumCostSince(Date.now() - 30 * 24 * 60 * 60 * 1000), [jobsWithRunData]);

  const systemStatus: { color: string; label: string } = jobsProblem.some((j: any) => j.status === "error")
    ? { color: "var(--color-brand-red)", label: "Есть ошибка" }
    : jobsProblem.length > 0
      ? { color: "var(--color-brand-orange, #d97706)", label: "Требуется решение" }
      : jobsActive.length > 0
        ? { color: "var(--color-brand-blue)", label: "Производство идёт" }
        : jobs.length === 0
          ? { color: "var(--color-text-secondary)", label: "Готова к работе" }
          : { color: "var(--color-severity-low)", label: "Готова к работе" };

  function goToJob(id: string) {
    window.location.href = `/admin/editorial/jobs/${id}`;
  }

  const nextAction: { text: string; cta: string; onClick: () => void } = (() => {
    const problemJob = jobsProblem[0];
    if (problemJob?.status === "error") return { text: `Ошибка в производстве «${problemJob.title}»`, cta: "Открыть", onClick: () => goToJob(problemJob.id) };
    if (problemJob?.status === "deploy_failed") return { text: `«${problemJob.title}» — ошибка сборки/деплоя после публикации`, cta: "Открыть", onClick: () => goToJob(problemJob.id) };
    if (problemJob?.status === "validation_failed") return { text: `«${problemJob.title}» — не прошла проверку перед публикацией`, cta: "Открыть", onClick: () => goToJob(problemJob.id) };
    if (problemJob?.status === "commit_failed") return { text: `«${problemJob.title}» — ошибка коммита в GitHub`, cta: "Открыть", onClick: () => goToJob(problemJob.id) };
    if (problemJob?.status === "paused") return { text: `Производство «${problemJob.title}» остановлено по бюджету`, cta: "Открыть", onClick: () => goToJob(problemJob.id) };
    if (problemJob) return { text: `«${problemJob.title}» — медицинская проверка нашла проблемы`, cta: "Проверить", onClick: () => goToJob(problemJob.id) };
    if (jobsReadyToApprove.length > 0) {
      const j = jobsReadyToApprove[0];
      return {
        text: jobsReadyToApprove.length === 1 ? `«${j.title}» готов к публикации` : `${jobsReadyToApprove.length} материала готовы к публикации`,
        cta: "Открыть",
        onClick: () => goToJob(j.id),
      };
    }
    if (jobsActive.length > 0) {
      const j = jobsActive[0];
      return { text: `Идёт производство «${j.title}»`, cta: "Открыть", onClick: () => goToJob(j.id) };
    }
    if (strategyHighPriorityUnreviewed > 0) {
      return { text: `AI-стратег нашёл ${strategyHighPriorityUnreviewed} тем высокого приоритета`, cta: "Посмотреть", onClick: () => { window.location.href = "/admin/editorial/strategy"; } };
    }
    if (!latestStrategyRun) {
      return { text: "AI-стратег ещё не сформировал план", cta: "Запустить исследование", onClick: () => { window.location.href = "/admin/editorial/strategy"; } };
    }
    const daysSinceStrategy = (Date.now() - new Date(latestStrategyRun.created_at).getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceStrategy > 30) {
      return { text: "Последнее исследование устарело (более 30 дней)", cta: "Обновить", onClick: () => { window.location.href = "/admin/editorial/strategy"; } };
    }
    if (activeIdeas.length > 0) {
      return { text: `${activeIdeas.length} тем в контент-плане ждут запуска в производство`, cta: "Открыть план", onClick: () => { window.location.href = "/admin/editorial/plan"; } };
    }
    return { text: "Нет материалов в производстве", cta: "Запустить следующую тему", onClick: () => { window.location.href = "/admin/editorial/plan"; } };
  })();

  if (phase === "checking") return (<><AdminNav current="editorial" /><Centered>Проверка доступа…</Centered></>);
  if (phase === "loading") return (<><AdminNav current="editorial" /><Centered>Загрузка…</Centered></>);
  if (phase === "unauthorized")
    return (
      <>
        <AdminNav current="editorial" />
        <Centered>
          Нужно войти в аккаунт.{" "}
          <a href="/auth/login" style={{ color: "var(--color-brand-blue)" }}>Войти</a>
        </Centered>
      </>
    );
  if (phase === "forbidden") return (<><AdminNav current="editorial" /><Centered>Доступ к этой странице ограничен.</Centered></>);
  if (phase === "error") return (<><AdminNav current="editorial" /><Centered>Не удалось загрузить данные: {errorMessage}</Centered></>);

  return (
    <div style={{ maxWidth: "var(--container-wide)", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
      <AdminNav current="editorial" />
      <RefreshingHint show={refreshing} />
      {loadError && <RetryBanner message={loadError} onRetry={() => setReloadTick((t) => t + 1)} />}
      <div style={{ marginBottom: "var(--space-2)" }}>
        <h1 style={{ fontSize: "var(--font-size-xl)", fontWeight: "var(--font-weight-semibold)", margin: 0, color: "var(--color-text)" }}>AI-редакция MEDIZIN.RU</h1>
        <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)", margin: "6px 0 0", maxWidth: 640 }}>
          Исследует спрос, формирует контент-план, готовит материалы, проверяет факты и передаёт статьи на публикацию.
        </p>
      </div>

      <EditorialSubNav
        active={section}
        workingCount={jobsWorkingOnly.length}
        problemCount={jobsProblem.length}
        planCount={activeIdeas.length}
        archiveCount={jobsArchive.length}
      />

      {section === "jobs" && openJobId ? (
        <JobScreen jobId={openJobId} accessToken={accessToken} onClose={() => { window.location.href = "/admin/editorial/jobs"; }} onIdeasChanged={() => accessToken && refreshHub(accessToken)} />
      ) : section === "overview" ? (
        <AiEditorialHub
          systemStatus={systemStatus}
          workerStatus={workerStatus}
          jobsActive={jobsActive}
          jobsAwaitingDecision={jobsAwaitingDecision}
          jobsReadyToApprove={jobsReadyToApprove}
          jobsProblem={jobsProblem}
          jobsErrorOnly={jobsErrorOnly}
          jobsStalledOnly={jobsStalledOnly}
          jobsAwaitingValidation={jobsAwaitingValidation}
          jobsAwaitingPublication={jobsAwaitingPublication}
          recentPublications={recentPublications}
          recentStops={recentStops}
          jobsPublishedTotal={jobsPublishedTotal}
          jobsPublishedToday={jobsPublishedToday}
          latestStrategyRun={latestStrategyRun}
          latestSuccessfulStrategyRun={latestSuccessfulStrategyRun}
          hasNewerUnfinishedStrategyRun={hasNewerUnfinishedStrategyRun}
          strategyIdeasAccepted={strategyIdeasAccepted}
          strategyIdeasRejected={strategyIdeasRejected}
          strategyHighPriorityUnreviewed={strategyHighPriorityUnreviewed}
          activeIdeasCount={activeIdeas.length}
          nextAction={nextAction}
          portfolioStats={portfolioStats}
          spendToday={spendToday}
          spend7d={spend7d}
          spend30d={spend30d}
          onOpenJob={goToJob}
          onGoToWorking={() => { window.location.href = "/admin/editorial/jobs"; }}
          onGoToProblem={() => { window.location.href = "/admin/editorial/jobs"; }}
          onGoToPlan={() => { window.location.href = "/admin/editorial/plan"; }}
          onGoToStrategy={() => { window.location.href = "/admin/editorial/strategy"; }}
          onGoToArchive={() => { window.location.href = "/admin/editorial/archive"; }}
        />
      ) : section === "strategy" ? (
        <StrategyPanel categories={categories} accessToken={accessToken} onIdeasChanged={() => accessToken && refreshHub(accessToken)} pendingAction={null} />
      ) : section === "plan" ? (
        <QueueTab
          ideas={ideas}
          ideasLoading={ideasLoading}
          categories={categories}
          categoryTitleBySlug={categoryTitleBySlug}
          accessToken={accessToken}
          onIdeasChanged={() => accessToken && refreshHub(accessToken)}
          registryItems={items}
          publishedSymptoms={publishedSymptoms}
          categoryFilter={queueCategoryFilter}
          setCategoryFilter={setQueueCategoryFilter}
          addPreset={null}
          onOpenJob={goToJob}
        />
      ) : section === "jobs" ? (
        (() => {
          // Часть 9 ТЗ ("Производство", группы) — jobsReadyToApprove и
          // deploying-jobs НЕ должны дублироваться внутри "В работе"
          // (jobsWorkingOnly изначально считается только для сводки хаба,
          // где такого разделения не требуется).
          const readyIds = new Set(jobsReadyToApprove.map((j: any) => j.id));
          const deploying = jobsWorkingOnly.filter((j: any) => j.status === "deploying");
          const deployingIds = new Set(deploying.map((j: any) => j.id));
          const workingOnly = jobsWorkingOnly.filter((j: any) => !readyIds.has(j.id) && !deployingIds.has(j.id));
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
              {/* ТЗ п.8 "Массовые операции" — панель действий над выбранными
                  материалами. Показывается только если что-то выбрано, чтобы
                  не занимать место в обычном режиме просмотра. */}
              {selectedJobIds.size > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "var(--color-neutral-100)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "10px 14px" }}>
                  <span style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)" }}>Выбрано: {selectedJobIds.size}</span>
                  <button disabled={bulkBusy} onClick={() => runBulkAction("retry")} style={{ ...HUB_SECONDARY_BTN, opacity: bulkBusy ? 0.6 : 1 }}>Повторить</button>
                  <button disabled={bulkBusy} onClick={() => runBulkAction("publish")} style={{ ...HUB_SECONDARY_BTN, opacity: bulkBusy ? 0.6 : 1 }}>Опубликовать</button>
                  <button disabled={bulkBusy} onClick={() => runBulkAction("archive")} style={{ ...HUB_SECONDARY_BTN, opacity: bulkBusy ? 0.6 : 1 }}>Архивировать</button>
                  <button disabled={bulkBusy} onClick={() => setSelectedJobIds(new Set())} style={{ background: "none", border: "none", color: "var(--color-text-secondary)", cursor: "pointer", font: "inherit", fontSize: "var(--font-size-sm)" }}>Снять выбор</button>
                  {bulkResultMsg && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>{bulkResultMsg}</span>}
                </div>
              )}
              <div>
                <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", marginBottom: 8 }}>В работе</div>
                <EditorialWorkingList jobs={workingOnly} onOpen={goToJob} onGoToPlan={() => { window.location.href = "/admin/editorial/plan"; }} selectedIds={selectedJobIds} onToggleSelect={toggleJobSelected} />
              </div>
              <div>
                <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", marginBottom: 8 }}>Требуют решения</div>
                <EditorialWorkingList jobs={jobsProblem} onOpen={goToJob} onGoToPlan={() => { window.location.href = "/admin/editorial/plan"; }} selectedIds={selectedJobIds} onToggleSelect={toggleJobSelected} />
              </div>
              <div>
                <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", marginBottom: 8 }}>Готовы к публикации</div>
                <EditorialWorkingList jobs={jobsReadyToApprove} onOpen={goToJob} onGoToPlan={() => { window.location.href = "/admin/editorial/plan"; }} selectedIds={selectedJobIds} onToggleSelect={toggleJobSelected} />
              </div>
              <div>
                <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", marginBottom: 8 }}>Ожидают сборки сайта</div>
                <EditorialWorkingList jobs={deploying} onOpen={goToJob} onGoToPlan={() => { window.location.href = "/admin/editorial/plan"; }} selectedIds={selectedJobIds} onToggleSelect={toggleJobSelected} />
              </div>
            </div>
          );
        })()
      ) : (
        <EditorialArchiveList jobs={jobsArchive} onOpen={goToJob} />
      )}
    </div>
  );
}

function HubMetric({
  label, value, hint, color, onClick,
}: { label: string; value: string | number; hint?: string; color?: string; onClick?: () => void }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      style={{
        background: "var(--color-neutral-100)",
        border: "none",
        borderRadius: "var(--radius-md)",
        padding: "10px 12px",
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        font: "inherit",
        color: "inherit",
      }}
    >
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>{label}</div>
      <div style={{ fontSize: "var(--font-size-lg)", fontWeight: "var(--font-weight-semibold)", color: color ?? "var(--color-text)" }}>{value}</div>
      {hint && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{hint}</div>}
    </Comp>
  );
}

function jobStageProgressLabel(job: any): string {
  const stepIndex = JOB_STAGE_STEPS.findIndex((s) => s.key === job.current_stage);
  return JOB_STAGE_STEPS.map((s, i) => (i < stepIndex ? `${s.label} ✓` : i === stepIndex ? `${s.label} ●` : s.label)).join("  —  ");
}

function ActiveStateCard({ job, extraCount, onOpen, onShowAll }: { job: any; extraCount: number; onOpen: () => void; onShowAll: () => void }) {
  const rs = job.run_stats ?? { totalCostUsd: 0, totalDurationMs: 0, totalCalls: 0 };
  const stepIndex = JOB_STAGE_STEPS.findIndex((s) => s.key === job.current_stage);
  return (
    <div style={{ background: "var(--color-neutral-100)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.4 }}>Сейчас в работе</div>
      <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", margin: "2px 0 4px", color: "var(--color-text)" }}>{job.title}</div>
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 8 }}>
        {STAGE_RUN_LABELS[job.current_stage] ?? job.current_stage} · этап {Math.max(1, stepIndex + 1)} из {JOB_STAGE_STEPS.length}
      </div>
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 10 }}>{jobStageProgressLabel(job)}</div>
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text)", marginBottom: 12 }}>
        {fmtDurationShort(rs.totalDurationMs)} · ~{fmtCost(rs.totalCostUsd)} · {rs.totalCalls} AI-вызов{rs.totalCalls === 1 ? "" : "а"}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={onOpen} style={HUB_PRIMARY_BTN}>Открыть производство →</button>
        {extraCount > 0 && <LinkStat onClick={onShowAll}>Посмотреть все {extraCount + 1} →</LinkStat>}
      </div>
    </div>
  );
}

function ProblemStateCard({ job, onOpen }: { job: any; onOpen: () => void }) {
  const isStopped = job.status === "paused" || job.status === "error";
  const stepIndex = JOB_STAGE_STEPS.findIndex((s) => s.key === job.current_stage);
  const lastGoodStep = stepIndex > 0 ? JOB_STAGE_STEPS[stepIndex - 1].label : null;
  const color = isStopped ? "var(--color-brand-red)" : "var(--color-brand-orange, #d97706)";
  return (
    <div style={{ background: "#fff", border: `1px solid ${color}`, borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
      <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-semibold)", color, marginBottom: 4 }}>
        {isStopped ? "Производство остановлено" : "Требуется ваше решение"}
      </div>
      <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)", color: "var(--color-text)", marginBottom: 4 }}>{job.title}</div>
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 6 }}>{job.decision_reason ?? "—"}</div>
      {isStopped && lastGoodStep && (
        <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: 10 }}>Последний успешный этап: {lastGoodStep}</div>
      )}
      <button onClick={onOpen} style={HUB_PRIMARY_BTN}>{isStopped ? "Открыть" : "Проверить материал →"}</button>
    </div>
  );
}

function ReadyStateCard({ job, extraCount, onOpen }: { job: any; extraCount: number; onOpen: () => void }) {
  return (
    <div style={{ background: "var(--color-neutral-100)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
      <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-severity-low)", marginBottom: 4 }}>Готово к решению</div>
      <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)", color: "var(--color-text)", marginBottom: 10 }}>{job.title}</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={onOpen} style={HUB_PRIMARY_BTN}>Проверить →</button>
        {extraCount > 0 && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>+{extraCount} ещё ждут решения</span>}
      </div>
    </div>
  );
}

function EmptyHubState({ hasAnyJobs, activeIdeasCount, onGoToQueue }: { hasAnyJobs: boolean; activeIdeasCount: number; onGoToQueue: () => void }) {
  return (
    <div style={{ background: "var(--color-neutral-100)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
      <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)", marginBottom: 10 }}>
        {hasAnyJobs ? "Сейчас производство не запущено." : "AI-редакция готова создать первый материал."}
        {activeIdeasCount > 0 ? ` В контент-плане ждёт ${activeIdeasCount} ${activeIdeasCount === 1 ? "тема" : "тем"}.` : ""}
      </div>
      <button onClick={onGoToQueue} style={HUB_PRIMARY_BTN}>Запустить следующую тему</button>
    </div>
  );
}

function AiEditorialHub({
  systemStatus,
  workerStatus,
  jobsActive,
  jobsAwaitingDecision,
  jobsReadyToApprove,
  jobsProblem,
  jobsErrorOnly,
  jobsStalledOnly,
  jobsAwaitingValidation,
  jobsAwaitingPublication,
  recentPublications,
  recentStops,
  jobsPublishedTotal,
  jobsPublishedToday,
  latestStrategyRun,
  latestSuccessfulStrategyRun,
  hasNewerUnfinishedStrategyRun,
  strategyIdeasAccepted,
  strategyIdeasRejected,
  strategyHighPriorityUnreviewed,
  activeIdeasCount,
  nextAction,
  portfolioStats,
  spendToday,
  spend7d,
  spend30d,
  onOpenJob,
  onGoToWorking,
  onGoToProblem,
  onGoToPlan,
  onGoToStrategy,
  onGoToArchive,
}: {
  systemStatus: { color: string; label: string };
  workerStatus: { online: boolean; reason: string | null; lastSeenAt: string | null } | null;
  jobsActive: any[];
  jobsAwaitingDecision: any[];
  jobsReadyToApprove: any[];
  jobsProblem: any[];
  jobsErrorOnly: any[];
  jobsStalledOnly: any[];
  jobsAwaitingValidation: any[];
  jobsAwaitingPublication: any[];
  recentPublications: any[];
  recentStops: any[];
  jobsPublishedTotal: number;
  jobsPublishedToday: number;
  latestStrategyRun: any | null;
  latestSuccessfulStrategyRun: any | null;
  hasNewerUnfinishedStrategyRun: boolean;
  strategyIdeasAccepted: number;
  strategyIdeasRejected: number;
  strategyHighPriorityUnreviewed: number;
  activeIdeasCount: number;
  nextAction: { text: string; cta: string; onClick: () => void };
  portfolioStats: { count: number; avgCostUsd: number; avgDurationMs: number; avgCalls?: number; avgInputTokens?: number; avgOutputTokens?: number } | null;
  spendToday: number;
  spend7d: number;
  spend30d: number;
  onOpenJob: (id: string) => void;
  onGoToWorking: () => void;
  onGoToProblem: () => void;
  onGoToPlan: () => void;
  onGoToStrategy: () => void;
  onGoToArchive: () => void;
}) {
  const featuredProblem = jobsProblem[0] ?? null;
  const featuredActive = !featuredProblem ? jobsActive[0] ?? null : null;
  const featuredReady = !featuredProblem && !featuredActive ? jobsReadyToApprove[0] ?? null : null;
  const hasAnyJobs = jobsActive.length > 0 || jobsPublishedTotal > 0 || jobsAwaitingDecision.length > 0;

  return (
    <div style={{ background: "#fff", border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", padding: "var(--space-5)" }}>
      {/* Верхняя строка — п.5 ТЗ */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: "var(--space-3)" }}>
        <div>
          <div style={{ fontSize: "var(--font-size-lg)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)" }}>AI-редакция MEDIZIN.RU</div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginTop: 2, maxWidth: 560 }}>
            AI самостоятельно исследует медицинские темы, формирует контент-план, пишет статьи, проверяет факты и передаёт материалы на публикацию.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", whiteSpace: "nowrap", color: "var(--color-text)" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: systemStatus.color, display: "inline-block" }} />
          {systemStatus.label}
        </div>
      </div>

      {/* ТЗ "Editorial Engine 2.0", п.1/5 — "Worker offline" должен быть
          заметной, понятной ошибкой, а не молчаливой остановкой всего
          производства. workerStatus===null означает "ещё не загрузили", в
          этот момент банер намеренно не показываем (не ложная тревога). */}
      {workerStatus && !workerStatus.online && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fdecea", border: "1px solid var(--color-brand-red)", borderRadius: "var(--radius-md)", padding: "10px 14px", marginBottom: "var(--space-3)", fontSize: "var(--font-size-sm)", color: "var(--color-brand-red)" }}>
          <strong>Worker недоступен.</strong>
          <span>
            {workerStatus.reason === "never_started"
              ? "Фоновый процесс производства ни разу не выходил на связь."
              : workerStatus.lastSeenAt
                ? `Не отвечает с ${fmtTime(workerStatus.lastSeenAt)}.`
                : "Не отвечает."}
            {" "}Автоматическое производство и публикация приостановлены до восстановления процесса.
          </span>
        </div>
      )}

      {/* Визуальная схема возможностей — п.6 ТЗ, лаконичная строка, не карточки */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: "var(--space-4)", paddingBottom: "var(--space-4)", borderBottom: "1px solid var(--color-border)" }}>
        {PIPELINE_STEPS_INFO.map((step, i) => (
          <React.Fragment key={step.label}>
            {i > 0 && <span style={{ color: "var(--color-neutral-400)" }}>→</span>}
            <span><span style={{ marginRight: 4 }}>{step.icon}</span>{step.label}</span>
          </React.Fragment>
        ))}
      </div>

      {/* Основные показатели — 5 штук (п.7 ТЗ допускает 4-5). "Нужен человек"
          и "Готовы к публикации" разделены (было одно слитное "Ждут
          решения") — реальная проблема и "просто ещё не нажали публикация"
          не должны выглядеть одинаково тревожно (п.6, 8-9 ТЗ). */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <HubMetric label="В контент-плане" value={activeIdeasCount} onClick={activeIdeasCount ? onGoToPlan : undefined} />
        <HubMetric label="В работе" value={jobsActive.length} onClick={jobsActive.length ? onGoToWorking : undefined} />
        <HubMetric
          label="Требуют решения"
          value={jobsProblem.length}
          color={jobsProblem.length > 0 ? "var(--color-brand-red)" : undefined}
          onClick={jobsProblem.length ? () => onOpenJob(jobsProblem[0].id) : undefined}
        />
        <HubMetric
          label="Готовы к публикации"
          value={jobsReadyToApprove.length}
          color={jobsReadyToApprove.length > 0 ? "var(--color-severity-low)" : undefined}
          onClick={jobsReadyToApprove.length ? () => onOpenJob(jobsReadyToApprove[0].id) : undefined}
        />
        <HubMetric label="Опубликовано" value={jobsPublishedTotal} onClick={jobsPublishedTotal ? onGoToArchive : undefined} />
      </div>

      {/* Главное активное состояние — п.8-10, 20 ТЗ */}
      <div style={{ marginBottom: "var(--space-4)" }}>
        {featuredProblem ? (
          <ProblemStateCard job={featuredProblem} onOpen={() => onOpenJob(featuredProblem.id)} />
        ) : featuredActive ? (
          <ActiveStateCard job={featuredActive} extraCount={jobsActive.length - 1} onOpen={() => onOpenJob(featuredActive.id)} onShowAll={onGoToWorking} />
        ) : featuredReady ? (
          <ReadyStateCard job={featuredReady} extraCount={jobsReadyToApprove.length - 1} onOpen={() => onOpenJob(featuredReady.id)} />
        ) : (
          <EmptyHubState hasAnyJobs={hasAnyJobs} activeIdeasCount={activeIdeasCount} onGoToQueue={onGoToPlan} />
        )}
      </div>

      {/* Список активных производств — "Сейчас в работе" (п.2, 17 ТЗ), максимум 3, с ссылкой на полный список во вкладке "В работе". */}
      {jobsActive.length > 1 && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {jobsActive.slice(0, 3).map((j) => {
              const rs = j.run_stats ?? { totalCostUsd: 0, totalDurationMs: 0, totalCalls: 0 };
              return (
                <button key={j.id} onClick={() => onOpenJob(j.id)} style={{ textAlign: "left", background: "none", border: "none", padding: "4px 0", cursor: "pointer", font: "inherit", fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
                  <span style={{ color: "var(--color-text)", fontWeight: "var(--font-weight-medium)" }}>{j.title}</span>{" "}
                  {STAGE_RUN_LABELS[j.current_stage] ?? j.current_stage} · {fmtDurationShort(rs.totalDurationMs)} · {fmtCost(rs.totalCostUsd)}
                </button>
              );
            })}
          </div>
          {jobsActive.length > 3 && <div style={{ marginTop: 4 }}><LinkStat onClick={onGoToWorking}>Все производства →</LinkStat></div>}
        </div>
      )}

      {/* AI-стратег внутри виджета — краткая сводка (п.11 ТЗ), сам инструмент — во вкладке "AI-стратег" ниже. */}
      <div style={{ background: "var(--color-neutral-100)", borderRadius: "var(--radius-md)", padding: "var(--space-3) var(--space-4)", marginBottom: "var(--space-4)", fontSize: "var(--font-size-xs)" }}>
        <div style={{ fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)", marginBottom: 4 }}>AI-стратег</div>
        {latestSuccessfulStrategyRun ? (
          <>
            <div style={{ color: "var(--color-text-secondary)" }}>
              Последнее успешное исследование: {fmtDateShort(latestSuccessfulStrategyRun.created_at)} · найдено {latestSuccessfulStrategyRun.stats?.proposedCount ?? 0} перспективных тем
              {strategyHighPriorityUnreviewed > 0 ? `, ${strategyHighPriorityUnreviewed} с высоким приоритетом` : ""}.
              {/* Часть 8 ТЗ ("для AI-стратега: стоимость одного исследования;
                  стоимость одной найденной темы") — раньше estimated_cost_usd
                  сохранялся в БД, но нигде не отображался. */}
              {typeof latestSuccessfulStrategyRun.estimated_cost_usd === "number" && (
                <> · {fmtCost(latestSuccessfulStrategyRun.estimated_cost_usd)}
                  {(latestSuccessfulStrategyRun.stats?.proposedCount ?? 0) > 0 ? ` (~${fmtCost(latestSuccessfulStrategyRun.estimated_cost_usd / latestSuccessfulStrategyRun.stats.proposedCount)}/тему)` : ""}
                </>
              )}
            </div>
            <div style={{ color: "var(--color-text-secondary)", marginTop: 2 }}>
              В плане: {strategyIdeasAccepted} · Отклонено: {strategyIdeasRejected}
            </div>
          </>
        ) : (
          <div style={{ color: "var(--color-text-secondary)" }}>Последнее успешное исследование отсутствует.</div>
        )}
        {/* Критические исправления AI-редакции (п.1 ТЗ) — если есть более
            новая незавершённая/упавшая попытка (например, зависла в
            "running" из-за таймаута), явно сообщаем об этом отдельной
            строкой, а не молчим и не путаем её с последним успешным
            результатом выше. */}
        {hasNewerUnfinishedStrategyRun && (
          <div style={{ color: "var(--color-brand-orange, #d97706)", marginTop: 4 }}>
            Есть незавершённое исследование от {fmtDateShort(latestStrategyRun.created_at)}
            {" · "}
            <button onClick={onGoToStrategy} style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", font: "inherit" }}>
              продолжить
            </button>
          </div>
        )}
      </div>

      {/* ТЗ "Editorial Engine 2.0", п.9 "Dashboard" — "сколько материалов
          произведено сегодня / в работе / с ошибками / ожидают
          проверки/публикации / застряло" должно быть видно за секунды. Это
          более тонкая раскладка поверх уже существующих метрик выше
          (которые остаются как есть — это ДОПОЛНЕНИЕ, не замена). */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <HubMetric label="Опубликовано сегодня" value={jobsPublishedToday} onClick={jobsPublishedToday ? onGoToArchive : undefined} />
        <HubMetric label="Ошибки" value={jobsErrorOnly.length} color={jobsErrorOnly.length > 0 ? "var(--color-brand-red)" : undefined} onClick={jobsErrorOnly.length ? () => onOpenJob(jobsErrorOnly[0].id) : undefined} />
        <HubMetric label="Остановлено (бюджет)" value={jobsStalledOnly.length} color={jobsStalledOnly.length > 0 ? "var(--color-severity-medium, #b8860b)" : undefined} onClick={jobsStalledOnly.length ? () => onOpenJob(jobsStalledOnly[0].id) : undefined} />
        <HubMetric label="Ждут проверки" value={jobsAwaitingValidation.length} onClick={jobsAwaitingValidation.length ? () => onOpenJob(jobsAwaitingValidation[0].id) : undefined} />
        <HubMetric label="Ждут публикации" value={jobsAwaitingPublication.length} onClick={jobsAwaitingPublication.length ? () => onOpenJob(jobsAwaitingPublication[0].id) : undefined} />
      </div>

      {/* Недавние публикации / недавние остановки — п.9 ТЗ ("последние
          публикации", "последние остановки процессов"). Компактные ленты, по
          5 записей, каждая кликабельна — это единственное место в хабе, где
          видно ленту СОБЫТИЙ, а не только текущий срез состояния. */}
      {(recentPublications.length > 0 || recentStops.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-4)", marginBottom: "var(--space-4)" }}>
          {recentPublications.length > 0 && (
            <div>
              <div style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)", marginBottom: 4 }}>Последние публикации</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {recentPublications.map((j: any) => (
                  <button key={j.id} onClick={() => onOpenJob(j.id)} style={{ textAlign: "left", background: "none", border: "none", padding: "2px 0", cursor: "pointer", font: "inherit", fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
                    <span style={{ color: "var(--color-text)" }}>{j.title}</span> · {fmtDateShort(j.updated_at)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {recentStops.length > 0 && (
            <div>
              <div style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)", marginBottom: 4 }}>Последние остановки</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {recentStops.map((j: any) => (
                  <button key={j.id} onClick={() => onOpenJob(j.id)} style={{ textAlign: "left", background: "none", border: "none", padding: "2px 0", cursor: "pointer", font: "inherit", fontSize: "var(--font-size-xs)", color: "var(--color-brand-red)" }}>
                    <span style={{ color: "var(--color-text)" }}>{j.title}</span> · {fmtDateShort(j.updated_at)}
                    {j.decision_reason && <span style={{ color: "var(--color-text-secondary)" }}> · {humanizeError(j.decision_reason).summary}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Следующее рекомендуемое действие — п.12 ТЗ */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, background: "#fff", border: "1px solid var(--color-brand-blue)", borderRadius: "var(--radius-md)", padding: "10px 14px", marginBottom: "var(--space-4)" }}>
        <div>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.4 }}>Следующее действие</div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text)" }}>{nextAction.text}</div>
        </div>
        <button onClick={nextAction.onClick} style={HUB_PRIMARY_BTN}>{nextAction.cta}</button>
      </div>

      {/* Расходы (Часть 8 ТЗ) — всегда видимая строка, не вкладка и не
          свёрнутая деталь: сегодня/неделя/месяц + средняя стоимость и
          длительность статьи, если данных уже достаточно. */}
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: "var(--space-4)", paddingBottom: "var(--space-4)", borderBottom: "1px solid var(--color-border)" }}>
        Расходы — сегодня: <strong style={{ color: "var(--color-text)" }}>{fmtCost(spendToday)}</strong>
        {" · "}неделя: <strong style={{ color: "var(--color-text)" }}>{fmtCost(spend7d)}</strong>
        {" · "}месяц: <strong style={{ color: "var(--color-text)" }}>{fmtCost(spend30d)}</strong>
        {portfolioStats && (
          <>
            {" · "}средняя статья: <strong style={{ color: "var(--color-text)" }}>{fmtCost(portfolioStats.avgCostUsd)}</strong>
            {" · "}среднее время: <strong style={{ color: "var(--color-text)" }}>{fmtDurationShort(portfolioStats.avgDurationMs)}</strong>
          </>
        )}
      </div>

    </div>
  );
}

function EditorialSubNav({
  active, workingCount, problemCount, planCount, archiveCount,
}: { active: EditorialSection; workingCount: number; problemCount: number; planCount: number; archiveCount: number }) {
  const items: Array<{ key: EditorialSection; label: string; href: string }> = [
    { key: "overview", label: "Обзор", href: "/admin/editorial" },
    { key: "strategy", label: "AI-стратег", href: "/admin/editorial/strategy" },
    { key: "plan", label: `Контент-план (${planCount})`, href: "/admin/editorial/plan" },
    { key: "jobs", label: `Производство (${workingCount + problemCount})`, href: "/admin/editorial/jobs" },
    { key: "archive", label: `Архив (${archiveCount})`, href: "/admin/editorial/archive" },
  ];
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: "var(--space-4)", flexWrap: "wrap" }}>
      {items.map((item) => (
        <a
          key={item.key}
          href={item.href}
          style={{
            fontSize: "var(--font-size-sm)",
            padding: "6px 14px",
            borderRadius: "var(--radius-md)",
            background: active === item.key ? "#fff" : "transparent",
            color: active === item.key ? "var(--color-brand-blue)" : "var(--color-text-secondary)",
            fontWeight: active === item.key ? "var(--font-weight-medium)" : "var(--font-weight-regular)",
            boxShadow: active === item.key ? "var(--shadow-sm)" : "none",
            textDecoration: "none",
          }}
        >
          {item.label}
        </a>
      ))}
    </div>
  );
}

function EditorialWorkingList({
  jobs, onOpen, onGoToPlan, selectedIds, onToggleSelect,
}: {
  jobs: any[];
  onOpen: (id: string) => void;
  onGoToPlan: () => void;
  // ТЗ п.8 "Массовые операции" — необязательные пропсы: не все вызовы этого
  // списка нуждаются в выборе (сейчас нужен только в разделе "Производство").
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>
        Сейчас ничего не в работе.{" "}
        <button onClick={onGoToPlan} style={{ background: "none", border: "none", padding: 0, color: "var(--color-brand-blue)", cursor: "pointer", font: "inherit" }}>
          Открыть контент-план →
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {jobs.map((j) => {
        const rs = j.run_stats ?? { totalCostUsd: 0, totalDurationMs: 0, totalCalls: 0 };
        const outcome = computeJobOutcome(j);
        const isProblem = outcome === "needs_human" || outcome === "stopped_budget";
        const isReady = outcome === "done" || outcome === "done_with_notes";
        // ТЗ п.6 "Очередь как диспетчер" — статус-бейдж (Running/Waiting/
        // Paused/Retry/Failed/Completed) + причина, если она есть.
        const dispatcherState = computeDispatcherState(j);
        const stopReason = dispatcherStopReason(j);
        return (
          <div
            key={j.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "var(--color-neutral-100)",
              border: isProblem ? "1px solid var(--color-brand-red)" : "none",
              borderRadius: "var(--radius-md)",
              padding: "10px 12px",
            }}
          >
            {onToggleSelect && (
              <input
                type="checkbox"
                checked={selectedIds?.has(j.id) ?? false}
                onChange={() => onToggleSelect(j.id)}
                onClick={(e) => e.stopPropagation()}
                style={{ flexShrink: 0, cursor: "pointer" }}
                aria-label={`Выбрать «${j.title}»`}
              />
            )}
            <button
              onClick={() => onOpen(j.id)}
              style={{
                textAlign: "left",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                background: "none",
                border: "none",
                borderRadius: "var(--radius-md)",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                flexWrap: "wrap",
                flex: 1,
                minWidth: 0,
              }}
            >
              <span>
                <span style={{ color: "var(--color-text)", fontWeight: "var(--font-weight-medium)" }}>{j.title}</span>{" "}
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: "var(--font-weight-medium)",
                    color: DISPATCHER_STATE_COLORS[dispatcherState],
                    border: `1px solid ${DISPATCHER_STATE_COLORS[dispatcherState]}`,
                    borderRadius: "var(--radius-sm, 4px)",
                    padding: "1px 5px",
                    marginRight: 4,
                    whiteSpace: "nowrap",
                  }}
                >
                  {DISPATCHER_STATE_LABELS[dispatcherState]}
                </span>
                <span style={{ fontSize: "var(--font-size-xs)", color: isProblem ? "var(--color-brand-red)" : isReady ? "var(--color-severity-low)" : "var(--color-text-secondary)" }}>
                  {isReady || isProblem ? OUTCOME_LABELS[outcome] : STAGE_RUN_LABELS[j.current_stage] ?? j.current_stage}
                  {!isReady && !isProblem ? ` · ${fmtDurationShort(rs.totalDurationMs)} · ${fmtCost(rs.totalCostUsd)}` : ""}
                </span>
                {stopReason && (
                  <span style={{ display: "block", fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginTop: 2 }}>
                    Причина: {stopReason}
                  </span>
                )}
              </span>
              <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-blue)", whiteSpace: "nowrap" }}>Открыть →</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EditorialArchiveList({ jobs, onOpen }: { jobs: any[]; onOpen: (id: string) => void }) {
  // Infra v2, п.12 ТЗ — архив только растёт (каждый опубликованный/отклонённый
  // job остаётся здесь навсегда), поэтому рендерим постранично, а не весь
  // список сразу; сами данные по jobs уже загружены одним запросом (см.
  // refreshHub) — здесь ограничиваем только количество DOM-узлов за раз.
  const PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE);
  React.useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [jobs.length]);

  if (jobs.length === 0) {
    return <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>Пока ничего не опубликовано и не отклонено.</div>;
  }
  const EMPTY_RUN_STATS = { totalCostUsd: 0, totalDurationMs: 0, totalCalls: 0 };
  const visibleJobs = jobs.slice(0, visibleCount);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {visibleJobs.map((j) => {
        const rs = j.run_stats ?? EMPTY_RUN_STATS;
        const revisions = j.return_count ?? 0;
        return (
          <button
            key={j.id}
            onClick={() => onOpen(j.id)}
            style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 2, background: "var(--color-neutral-100)", border: "none", borderRadius: "var(--radius-md)", padding: "10px 12px", cursor: "pointer", font: "inherit" }}
          >
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>
                <span style={{ color: "var(--color-text)", fontWeight: "var(--font-weight-medium)" }}>{j.title}</span>{" "}
                <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>{JOB_STATUS_LABELS[j.status] ?? j.status}</span>
              </span>
              <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-blue)", whiteSpace: "nowrap" }}>Открыть →</span>
            </span>
            <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
              Создано: {fmtDateShort(j.created_at)}
              {" · "}правок: {revisions}
              {" · "}{rs.totalCalls} AI-вызов{rs.totalCalls === 1 ? "" : "а"}
              {" · "}{fmtCost(rs.totalCostUsd)}
              {" · "}{fmtDurationShort(rs.totalDurationMs)}
              {j.status === "published" && (
                <>
                  {" · "}опубликовано: {fmtTime(j.published_at)}
                  {" "}({j.published_by_email ?? "неизвестно"})
                </>
              )}
            </span>
          </button>
        );
      })}
      {jobs.length > visibleJobs.length && (
        <button
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          style={{ ...HUB_SECONDARY_BTN, alignSelf: "flex-start" }}
        >
          Показать ещё ({jobs.length - visibleJobs.length})
        </button>
      )}
    </div>
  );
}

function IdeaRow({
  idea, categoryTitleBySlug, accessToken, onChanged, publishedMatch, onOpenJob,
}: {
  idea: any; categoryTitleBySlug: Map<string, string>; accessToken: string | null; onChanged: () => void;
  publishedMatch?: any | null;
  onOpenJob: (jobId: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [creatingJob, setCreatingJob] = useState(false);
  const [jobConflict, setJobConflict] = useState<{ reason: string; duplicateCandidates: any[] } | null>(null);
  const [jobError, setJobError] = useState("");

  async function patch(fields: Record<string, string>) {
    if (!accessToken) return;
    setSaving(true);
    try {
      await fetch(`/api/admin/content/ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(fields),
      });
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  // «Создать материал» (п.4 ТЗ, Этап 3) — превращает тему в производственную
  // задачу (content_job). Перед стартом сервер сам ещё раз проверяет дубли
  // (тем же searchRegistry, что и при добавлении идеи) — если похоже, что
  // материал уже есть, показываем это здесь и ждём явного подтверждения
  // человека (п.12 ТЗ), а не запускаем производство молча.
  async function createJob(confirmDespiteDuplicate = false) {
    if (!accessToken) return;
    setCreatingJob(true);
    setJobError("");
    try {
      const res = await fetch("/api/admin/content/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ideaId: idea.id, confirmDespiteDuplicate }),
      });
      const json = await res.json();
      if (!json.ok) {
        setJobError(json.error ?? "Не удалось создать задачу производства");
        return;
      }
      if (json.created === false) {
        if (json.existingJobId) {
          onOpenJob(json.existingJobId);
          return;
        }
        if (json.preflight) {
          setJobConflict(json.preflight);
          return;
        }
        setJobError(json.error ?? "Не удалось создать задачу производства");
        return;
      }
      setJobConflict(null);
      onChanged();
      onOpenJob(json.job.id);
    } finally {
      setCreatingJob(false);
    }
  }

  const isFinal = idea.status === "created" || idea.status === "rejected" || idea.status === "archived";
  const checkSummary = idea.conflictNote ?? "Похожих материалов не найдено";

  return (
    <div style={{ background: "#fff", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-3) var(--space-4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <strong style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text)" }}>{idea.workingTitle}</strong>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginTop: 2 }}>
            {idea.category ? categoryTitleBySlug.get(idea.category) ?? idea.category : "Без раздела"} · {REASON_LABELS[idea.reason] ?? idea.reason}
          </div>
        </div>
        <span style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", color: IDEA_PRIORITY_COLOR[idea.priority] }}>
          {PRIORITY_LABELS[idea.priority] ?? idea.priority} приоритет
        </span>
      </div>

      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginTop: 8 }}>
        <strong style={{ color: "var(--color-text)" }}>Проверка: </strong>{checkSummary}
      </div>
      <div style={{ fontSize: "var(--font-size-xs)", marginTop: 4 }}>
        <strong style={{ color: "var(--color-text-secondary)" }}>Статус: </strong>
        <span style={{ color: "var(--color-text)", fontWeight: "var(--font-weight-medium)" }}>{IDEA_STATUS_LABELS[idea.status] ?? idea.status}</span>
      </div>

      {publishedMatch && !isFinal && (
        <div style={{ background: "var(--color-bg-info)", border: "1px solid var(--color-border-info)", borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-3)", marginTop: 8, fontSize: "var(--font-size-xs)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span>Похоже, эта тема уже опубликована как «{publishedMatch.title}».</span>
          <button
            onClick={() => patch({ status: "created" })}
            disabled={saving}
            style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "4px 10px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}
          >
            Отметить «Опубликована»
          </button>
        </div>
      )}

      {jobConflict && (
        <div style={{ background: "var(--color-bg-warning)", border: "1px solid var(--color-border-warning)", borderRadius: "var(--radius-md)", padding: "var(--space-3)", fontSize: "var(--font-size-xs)", marginTop: 8 }}>
          <div>{jobConflict.reason} Возможно, новая статья не нужна.</div>
          {jobConflict.duplicateCandidates?.[0] && (
            <a href={jobConflict.duplicateCandidates[0].url} target="_blank" rel="noreferrer" style={{ color: "var(--color-brand-blue)" }}>
              Открыть существующий материал ↗
            </a>
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button onClick={() => createJob(true)} disabled={creatingJob} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-red)", color: "#fff", cursor: "pointer" }}>
              Продолжить как отдельную тему
            </button>
            <button onClick={() => setJobConflict(null)} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
              Отменить
            </button>
          </div>
        </div>
      )}
      {jobError && <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-red)", marginTop: 6 }}>{jobError}</div>}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
        <button onClick={() => setExpanded((v) => !v)} style={{ fontSize: "var(--font-size-xs)", padding: "5px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
          {expanded ? "Свернуть" : "Открыть"}
        </button>
        {!isFinal && idea.status !== "in_progress" && (
          <button
            onClick={() => patch({ status: "in_progress" })}
            disabled={saving}
            style={{ fontSize: "var(--font-size-xs)", padding: "5px 10px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}
          >
            Начать работу
          </button>
        )}
        {!isFinal && (
          <button
            onClick={() => createJob(false)}
            disabled={creatingJob}
            style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "5px 10px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-severity-medium)", color: "#fff", cursor: "pointer" }}
          >
            {creatingJob ? "Запускаем…" : "Создать материал"}
          </button>
        )}
        {saving && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>Сохраняем…</span>}
      </div>

      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--color-border)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {idea.slug && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", fontFamily: "monospace" }}>slug: {idea.slug}</span>}
          <Select
            value={idea.status}
            onChange={(v) => patch({ status: v })}
            options={Object.entries(IDEA_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Select
            value={idea.priority}
            onChange={(v) => patch({ priority: v })}
            options={Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </div>
      )}
    </div>
  );
}

function AddIdeaForm({
  categories, accessToken, onSaved, registryItems, preset,
}: {
  categories: any[]; accessToken: string | null; onSaved: () => void; registryItems: any[];
  preset?: { nonce: number; category?: string; reason?: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [workingTitle, setWorkingTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState<string>("gap_in_cluster");
  const [priority, setPriority] = useState<string>("medium");
  // Явная типизация: searchRegistry() из .mjs даёт слишком общий object[] по JSDoc.
  const [preview, setPreview] = useState<any>(null);
  const [conflict, setConflict] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Клик "Добавить тему" в пробеле (п.8 ТЗ) — открывает форму сразу с
  // предзаполненным разделом/причиной.
  useEffect(() => {
    if (!preset) return;
    setOpen(true);
    setStep(1);
    setWorkingTitle("");
    if (preset.category) setCategory(preset.category);
    if (preset.reason) setReason(preset.reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce]);

  function runPreview() {
    if (!workingTitle.trim()) return;
    const result = searchRegistry(registryItems, workingTitle);
    setPreview(result);
    if (!category) setCategory(categories[0]?.slug ?? "");
    setSlug((prev) => prev || slugify(workingTitle));
    setStep(2);
  }

  async function submit(confirmDespiteConflict = false) {
    if (!accessToken || !workingTitle.trim()) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/content/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ workingTitle, slug, category, reason, priority, confirmDespiteConflict }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Не удалось сохранить тему");
        return;
      }
      if (json.saved === false) {
        setConflict(json.conflict);
        return;
      }
      setWorkingTitle("");
      setSlug("");
      setConflict(null);
      setPreview(null);
      setStep(1);
      setOpen(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setStep(1); }}
        style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}
      >
        + Добавить тему
      </button>
    );
  }

  return (
    <div style={{ background: "#fff", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            value={workingTitle}
            onChange={(e) => setWorkingTitle(e.target.value)}
            placeholder="Например: Озноб без температуры"
            autoFocus
            style={{ fontSize: "var(--font-size-sm)", padding: "8px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={runPreview}
              disabled={!workingTitle.trim()}
              style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}
            >
              Проверить тему
            </button>
            <button onClick={() => setOpen(false)} style={{ fontSize: "var(--font-size-sm)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {step === 2 && preview && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)" }}>{workingTitle}</div>
            <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginTop: 4 }}>
              {preview.exactLive.length > 0 && <>Точное совпадение: «{preview.exactLive[0].title}» ({preview.exactLive[0].id}).</>}
              {preview.exactLive.length === 0 && preview.exactRetired.length > 0 && <>Уже разбиралось ранее: «{preview.exactRetired[0].title}».</>}
              {preview.exactLive.length === 0 && preview.exactRetired.length === 0 && preview.similar.length > 0 && (
                <>Похоже на: «{preview.similar[0].item.title}» ({Math.round(preview.similar[0].score * 100)}%).</>
              )}
              {preview.exactLive.length === 0 && preview.exactRetired.length === 0 && preview.similar.length === 0 && "Совпадений не найдено."}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>Раздел:</label>
            <Select value={category} onChange={setCategory} options={categories.map((c: any) => ({ value: c.slug, label: c.title }))} />
            <label style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>Slug:</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              style={{ fontSize: "var(--font-size-xs)", padding: "6px 8px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", fontFamily: "monospace" }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Select value={reason} onChange={setReason} options={NEW_REASON_OPTIONS.map((value) => ({ value, label: REASON_LABELS[value] }))} />
            <Select value={priority} onChange={setPriority} options={Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))} />
          </div>

          {conflict && (
            <div style={{ background: "var(--color-bg-warning)", border: "1px solid var(--color-border-warning)", borderRadius: "var(--radius-md)", padding: "var(--space-3)", fontSize: "var(--font-size-sm)" }}>
              {conflict.recommendation === "exists" && conflict.exactLive.length > 0 && (
                <div>Возможный дубль. Уже существует: «{conflict.exactLive[0].title}» — {conflict.exactLive[0].id}.</div>
              )}
              {conflict.recommendation === "retired" && conflict.exactRetired.length > 0 && (
                <div>Тема существовала ранее. Была объединена/удалена: «{conflict.exactRetired[0].title}».</div>
              )}
              {conflict.recommendation === "check_similar" && conflict.similar.length > 0 && (
                <div>Похожая тема уже есть: «{conflict.similar[0].title}» ({Math.round(conflict.similar[0].score * 100)}% схожести).</div>
              )}
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <button onClick={() => submit(true)} disabled={saving} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-red)", color: "#fff", cursor: "pointer" }}>
                  Всё равно добавить
                </button>
                <button onClick={() => setConflict(null)} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
                  Отменить
                </button>
              </div>
            </div>
          )}

          {error && <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-red)" }}>{error}</div>}

          {!conflict && (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => submit(false)}
                disabled={saving}
                style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}
              >
                {saving ? "Сохраняем…" : "Добавить в контент-план"}
              </button>
              <button onClick={() => setStep(1)} style={{ fontSize: "var(--font-size-sm)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
                Назад
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StrategyPanel({
  categories, accessToken, onIdeasChanged, pendingAction,
}: {
  categories: any[]; accessToken: string | null; onIdeasChanged: () => void;
  pendingAction?: { nonce: number; type: "new" | "resume" } | null;
}) {
  const [open, setOpen] = useState(false);
  const [topicCount, setTopicCount] = useState(20);
  const [strategy, setStrategy] = useState("max_traffic");
  const [clusterCategory, setClusterCategory] = useState("");
  const [loading, setLoading] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [run, setRun] = useState<any | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [history, setHistory] = useState<any[]>([]);
  const [committing, setCommitting] = useState(false);

  const loadHistory = React.useCallback(async () => {
    if (!accessToken) return;
    const res = await fetch("/api/admin/content/strategy/runs", { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await res.json();
    if (j.ok) setHistory(j.items ?? []);
  }, [accessToken]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Большие кнопки шапки "Новая стратегия" / "Продолжить исследование"
  // (Этап 5 ТЗ) переключают вкладку на "AI-стратег" И сразу проставляют
  // нужное действие здесь — без этого клик по кнопке просто открывал бы
  // вкладку без какого-либо видимого эффекта, пока админ не нажмёт что-то
  // ещё раз внутри самой панели.
  useEffect(() => {
    if (!pendingAction) return;
    if (pendingAction.type === "new") {
      setRun(null);
      setOpen(true);
    } else if (pendingAction.type === "resume") {
      const target = history.find((r) => r.status === "error" || r.status === "stopped" || r.status === "running" || r.status === "interrupted") ?? history[0];
      if (target) resumeRun(target.id);
      else setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction?.nonce]);

  // Косметический прогресс (п.4 ТЗ) — реальный конвейер это один AI-вызов
  // (см. runs.ts), но администратору важно видеть, что вообще происходит,
  // а не смотреть на неподвижный спиннер минуты полторы.
  useEffect(() => {
    if (!loading) return;
    setProgressStep(0);
    const interval = setInterval(() => {
      setProgressStep((s) => Math.min(s + 1, STRATEGY_PROGRESS_STEPS.length - 1));
    }, 4000);
    return () => clearInterval(interval);
  }, [loading]);

  // Этап "Выделение AI Worker в отдельный независимый сервис" сделал
  // /runs (POST) и /runs/[id]/resume мгновенными — они только переводят
  // run в status='running' и возвращают снимок, реальную работу выполняет
  // отдельный процесс Worker в фоне (см. strategy-loop.ts). До этой правки
  // экран просто показывал этот единственный снимок и застывал на
  // "Выполняется: ..." навсегда, даже когда Worker уже давно всё закончил —
  // администратору приходилось вручную открывать run заново, чтобы увидеть
  // актуальный статус. Теперь, пока показанный run в статусе "running",
  // опрашиваем его же GET-эндпоинт и обновляем экран сами.
  useEffect(() => {
    if (!run || run.status !== "running" || !accessToken) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/admin/content/strategy/runs/${run.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const j = await res.json();
        if (cancelled || !j.ok || !j.run) return;
        setRun(j.run);
        if (j.run.status !== "running") {
          setSelected(new Set((j.run.candidates ?? []).map((_: any, i: number) => i)));
          loadHistory();
        }
      } catch {
        // Сеть моргнула — попробуем на следующем тике.
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [run?.id, run?.status, accessToken, loadHistory]);

  async function startRun() {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    setRun(null);
    try {
      const res = await fetch("/api/admin/content/strategy/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ topicCount, strategy, clusterCategory: strategy === "strengthen_cluster" ? clusterCategory : undefined }),
      });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error ?? "Не удалось сформировать контент-план");
        return;
      }
      setRun(j.run);
      setSelected(new Set((j.run.candidates ?? []).map((_: any, i: number) => i)));
      await loadHistory();
    } finally {
      setLoading(false);
    }
  }

  async function openPastRun(runId: string) {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/content/strategy/runs/${runId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error ?? "Не удалось открыть исследование");
        return;
      }
      setRun(j.run);
      setSelected(new Set((j.run.candidates ?? []).map((_: any, i: number) => i)));
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  async function resumeRun(runId: string) {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/content/strategy/runs/${runId}/resume`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error ?? "Не удалось продолжить исследование");
        return;
      }
      setRun(j.run);
      setSelected(new Set((j.run.candidates ?? []).map((_: any, i: number) => i)));
      await loadHistory();
    } finally {
      setLoading(false);
    }
  }

  // Исправление завершения старых запусков (новое ТЗ, п.6) — "Перезапустить
  // исследование" СОЗДАЁТ НОВЫЙ run с теми же параметрами (тема count/
  // стратегия/раздел, если были) и НЕ пытается чинить старый — в отличие от
  // "Продолжить", которая возобновляет именно тот run, на котором нажата.
  // Нужна отдельно, потому что часть старых run'ов застряла ДО того, как
  // AI вообще успел ответить (raw_candidates нет) — их "Продолжить" честно
  // попробует ещё раз вызвать AI на том же run'е, но если администратор
  // предпочитает начать с чистого листа, эта кнопка даёт такой путь явно.
  async function restartRun(oldRun: any) {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    setRun(null);
    try {
      const p = oldRun?.params ?? {};
      const res = await fetch("/api/admin/content/strategy/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          topicCount: TOPIC_COUNT_OPTIONS.includes(p.topicCount) ? p.topicCount : 20,
          strategy: p.strategy ?? "max_traffic",
          clusterCategory: p.strategy === "strengthen_cluster" ? p.clusterCategory : undefined,
        }),
      });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error ?? "Не удалось запустить новое исследование");
        return;
      }
      setRun(j.run);
      setSelected(new Set((j.run.candidates ?? []).map((_: any, i: number) => i)));
      await loadHistory();
    } finally {
      setLoading(false);
    }
  }

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function commit(indices: number[]) {
    if (!accessToken || !run || indices.length === 0) return;
    setCommitting(true);
    try {
      const res = await fetch(`/api/admin/content/strategy/runs/${run.id}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ selectedIndices: indices }),
      });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error ?? "Не удалось добавить темы");
        return;
      }
      onIdeasChanged();
      await loadHistory();
      setRun(null);
      setOpen(false);
    } finally {
      setCommitting(false);
    }
  }

  const lastRun = history[0];

  // Сводка по звёздным тирам (Этап 5 ТЗ) для строки отчёта выше списка.
  const tierCounts = useMemo(() => {
    const cands = run?.candidates ?? [];
    let stars5 = 0, stars4 = 0, stars3 = 0;
    for (const c of cands) {
      const t = tierStars(c.priorityScore);
      if (t === "★★★★★") stars5++;
      else if (t === "★★★★") stars4++;
      else stars3++;
    }
    return { stars5, stars4, stars3 };
  }, [run]);

  return (
    <div style={{ background: "#fff", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-4)", marginBottom: "var(--space-5)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)" }}>AI-стратег</div>
          <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)", margin: "4px 0 0", maxWidth: 560 }}>
            Найду самые важные темы, которых ещё нет на MEDIZIN.RU. Проверю существующие материалы, дубли, пробелы в кластерах и поисковый спрос.
          </p>
          {lastRun && (
            <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginTop: 8 }}>
              Последнее исследование: {fmtDateShort(lastRun.created_at)}
              {typeof lastRun.stats?.addedCount === "number" && typeof lastRun.stats?.proposedCount === "number" && (
                <> · Добавлено {lastRun.stats.addedCount} из {lastRun.stats.proposedCount} тем</>
              )}
              {typeof lastRun.estimated_cost_usd === "number" && (
                <> · {fmtCost(lastRun.estimated_cost_usd)}
                  {(lastRun.stats?.proposedCount ?? 0) > 0 ? ` (~${fmtCost(lastRun.estimated_cost_usd / lastRun.stats.proposedCount)}/тему)` : ""}
                </>
              )}
              {" · "}
              <button onClick={() => openPastRun(lastRun.id)} style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                Посмотреть исследование
              </button>
              {(lastRun.status === "error" || lastRun.status === "stopped" || lastRun.status === "running" || lastRun.status === "interrupted") && (
                <>
                  {" · "}
                  <button onClick={() => resumeRun(lastRun.id)} style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    Продолжить
                  </button>
                  {" · "}
                  <button onClick={() => restartRun(lastRun)} style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    Перезапустить исследование
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {!open && !run && (
          <button
            onClick={() => setOpen(true)}
            style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer", whiteSpace: "nowrap" }}
          >
            Сформировать контент-план
          </button>
        )}
      </div>

      {open && !run && !loading && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
              Количество тем
              <div style={{ marginTop: 4 }}>
                <Select value={String(topicCount)} onChange={(v) => setTopicCount(Number(v))} options={TOPIC_COUNT_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))} />
              </div>
            </label>
            <label style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
              Стратегия
              <div style={{ marginTop: 4 }}>
                <Select value={strategy} onChange={setStrategy} options={STRATEGY_OPTIONS} />
              </div>
            </label>
            {strategy === "strengthen_cluster" && (
              <label style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
                Раздел
                <div style={{ marginTop: 4 }}>
                  <Select value={clusterCategory} onChange={setClusterCategory} options={categories.map((c: any) => ({ value: c.slug, label: c.title }))} />
                </div>
              </label>
            )}
          </div>
          {error && <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-red)" }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={startRun}
              disabled={strategy === "strengthen_cluster" && !clusterCategory}
              style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}
            >
              Запустить исследование
            </button>
            <button onClick={() => setOpen(false)} style={{ fontSize: "var(--font-size-sm)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--color-border)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {STRATEGY_PROGRESS_STEPS.map((label, i) => (
              <div key={label} style={{ fontSize: "var(--font-size-sm)", color: i < progressStep ? "var(--color-severity-low)" : i === progressStep ? "var(--color-text)" : "var(--color-text-secondary)", fontWeight: i === progressStep ? "var(--font-weight-medium)" : "var(--font-weight-normal)" }}>
                {i < progressStep ? "✓" : i === progressStep ? "→" : "·"} {label}
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && run && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--color-border)" }}>
          {(run.status === "error" || run.status === "stopped" || run.status === "running" || run.status === "interrupted") ? (
            <div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-brand-red)" }}>
                {describeStrategyRunState(run)}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <button onClick={() => resumeRun(run.id)} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}>
                  Продолжить
                </button>
                <button onClick={() => restartRun(run)} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
                  Перезапустить исследование
                </button>
                <button onClick={() => { setRun(null); setOpen(true); }} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
                  Начать заново
                </button>
              </div>
              <StrategyRunDiagnostics run={run} />
            </div>
          ) : (
            <>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text)", marginBottom: 4 }}>Предлагаемый контент-план</div>
              {/* Полноценный отчёт (Этап 5 ТЗ, п. AI-стратег): "Проанализировано:
                  X опубликованных материалов, Y тем в истории, Z в текущем
                  контент-плане. Найдено кандидатов: ... Предлагается: A ★★★★★,
                  B ★★★★, C ★★★" — вместо прежнего единственного числа
                  "проанализировано N симптомов", которое и создавало
                  впечатление, что стратег "видит" только опубликованные
                  страницы. Точную частотность поисковых запросов сознательно
                  НЕ показываем как посчитанную цифру — модели прямо запрещено
                  её выдумывать (см. strategy.ts), а реальных данных поиска у
                  системы нет. */}
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 4 }}>
                Проанализировано: {run.stats?.analyzedPublished ?? 0} опубликованных материалов · {run.stats?.analyzedHistory ?? 0} тем в истории (объединено/удалено) · {run.stats?.analyzedPlan ?? 0} тем в текущем контент-плане.
              </div>
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 12 }}>
                Найдено кандидатов: {run.stats?.foundCandidates ?? 0} · Исключено как дубли: {run.stats?.excludedDuplicate ?? 0} · Исключено по истории: {run.stats?.excludedHistory ?? 0}.
                {" "}Предлагается: {tierCounts.stars5} ★★★★★, {tierCounts.stars4} ★★★★, {tierCounts.stars3} ★★★.
                {/* Часть 8 ТЗ: стоимость этого исследования + цена одной найденной темы. */}
                {typeof run.estimated_cost_usd === "number" && (
                  <>
                    {" "}Стоимость исследования: {fmtCost(run.estimated_cost_usd)}
                    {(run.stats?.proposedCount ?? 0) > 0 ? ` (~${fmtCost(run.estimated_cost_usd / run.stats.proposedCount)} за тему)` : ""}.
                  </>
                )}
              </div>

              {/* Этап 6, Часть 2 ТЗ: "0 тем без объяснения запрещено" — если
                  всё отсеялось на дедупе (не сбой AI, а честный итог анализа),
                  явно объясняем почему, а не просто показываем "Предложено: 0". */}
              {run.stats?.zeroReasonExplanation && (
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text)", background: "var(--color-neutral-100)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "8px 10px", marginBottom: 12 }}>
                  {run.stats.zeroReasonExplanation}
                </div>
              )}

              {error && <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-red)", marginBottom: 8 }}>{error}</div>}

              {run.status === "ready" && (run.candidates ?? []).length > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                  <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>Выбрано: {selected.size} из {(run.candidates ?? []).length}</span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {(run.candidates ?? []).length > 20 && (
                      <button
                        onClick={() => commit(Array.from({ length: 20 }, (_, i) => i))}
                        disabled={committing}
                        style={{ fontSize: "var(--font-size-xs)", padding: "6px 14px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}
                      >
                        Добавить первые 20
                      </button>
                    )}
                    <button
                      onClick={() => commit([...selected])}
                      disabled={committing || selected.size === 0}
                      style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "6px 14px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}
                    >
                      {committing ? "Добавляем…" : "Добавить выбранные"}
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 520, overflow: "auto" }}>
                {(run.candidates ?? []).map((c: any, i: number, arr: any[]) => {
                  const tier = tierStars(c.priorityScore);
                  const prevTier = i > 0 ? tierStars(arr[i - 1].priorityScore) : null;
                  return (
                  <React.Fragment key={i}>
                    {tier !== prevTier && (
                      <div style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text-secondary)", marginTop: i > 0 ? 8 : 0 }}>
                        {tier} {TIER_STARS_LABEL[tier]}
                      </div>
                    )}
                    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-3)", opacity: run.status === "ready" && !selected.has(i) ? 0.5 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        {run.status === "ready" && (
                          <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} style={{ marginTop: 4 }} />
                        )}
                        <div>
                          <strong style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text)" }}>{c.title}</strong>
                          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginTop: 2 }}>
                            {c.priority} · {c.priorityScore}/100 · Кластер: {c.category}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text)", marginTop: 8 }}>
                      <strong>Почему стоит создать: </strong>{c.rationale}
                    </div>
                    <div style={{ fontSize: "var(--font-size-xs)", marginTop: 4, color: c.duplicateCheckResult?.status === "possible_overlap" ? "var(--color-severity-medium)" : "var(--color-severity-low)" }}>
                      {c.duplicateCheckResult?.status === "possible_overlap" ? "⚠ Возможно пересечение: " : "✓ "}
                      {c.duplicateCheckResult?.note}
                    </div>
                    {run.status === "ready" && (
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button onClick={() => commit([i])} disabled={committing} style={{ fontSize: "11px", padding: "4px 10px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}>
                          Добавить в план
                        </button>
                        <button onClick={() => toggle(i)} style={{ fontSize: "11px", padding: "4px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
                          {selected.has(i) ? "Отклонить" : "Вернуть"}
                        </button>
                      </div>
                    )}
                    </div>
                  </React.Fragment>
                  );
                })}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button onClick={() => { setRun(null); setOpen(false); }} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
                  Закрыть
                </button>
              </div>
              <StrategyRunDiagnostics run={run} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function QueueTab({
  ideas,
  ideasLoading,
  categories,
  categoryTitleBySlug,
  accessToken,
  onIdeasChanged,
  registryItems,
  publishedSymptoms,
  categoryFilter,
  setCategoryFilter,
  addPreset,
  onOpenJob,
}: {
  ideas: any[];
  ideasLoading: boolean;
  categories: any[];
  categoryTitleBySlug: Map<string, string>;
  accessToken: string | null;
  onIdeasChanged: () => void;
  registryItems: any[];
  publishedSymptoms: any[];
  categoryFilter: string;
  setCategoryFilter: (v: string) => void;
  addPreset: { nonce: number; category?: string; reason?: string } | null;
  onOpenJob: (jobId: string) => void;
}) {
  // Автообнаружение уже опубликованного материала (п.12 ТЗ) — по slug+разделу.
  // Показывается только как предложение с подтверждением, статус не меняется
  // без клика администратора.
  function findPublishedMatch(idea: any) {
    if (!idea.slug) return null;
    return publishedSymptoms.find((s) => s.slug === idea.slug && (!idea.category || s.category === idea.category)) ?? null;
  }

  const filteredIdeas = categoryFilter === "all" ? ideas : ideas.filter((i) => i.category === categoryFilter);

  // Infra v2, п.12 ТЗ ("списки материалов подгружались постранично, а не
  // всей базой сразу") — контент-план реально может содержать 100+ идей
  // (каждая живёт как отдельный <IdeaRow> с собственным useState для
  // раскрытия/формы правки), и раньше рендерился весь список целиком за
  // один раз при каждом открытии вкладки. Сами данные по-прежнему
  // приходят одним запросом (объём для одной админской вкладки небольшой
  // — десятки KB JSON), а вот ДОРОГОЙ рендер множества стейтфул-компонентов
  // теперь постраничный: сначала PAGE_SIZE строк, дальше — по кнопке.
  const PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE);
  React.useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [categoryFilter, ideas.length]);
  const visibleIdeas = filteredIdeas.slice(0, visibleCount);
  const hasMoreIdeas = filteredIdeas.length > visibleIdeas.length;

  return (
    <div>
      {/* AI-стратег — переехал в свою собственную вкладку "AI-стратег"
          (см. EditorialSubNav/ContentDashboard) — здесь больше не
          встраивается, чтобы "Контент-план" не выглядел как склейка двух
          разных направлений (п.3 ТЗ). */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)" }}>
          Идеи для новых материалов ({filteredIdeas.length})
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <AddIdeaForm categories={categories} accessToken={accessToken} onSaved={onIdeasChanged} registryItems={registryItems} preset={addPreset} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: "var(--space-3)" }}>
        <Select
          value={categoryFilter}
          onChange={setCategoryFilter}
          options={[{ value: "all", label: "Все разделы" }, ...categories.map((c: any) => ({ value: c.slug, label: c.title }))]}
        />
      </div>
      <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginTop: 0 }}>
        Перед сохранением темы всегда проверяются дубли/похожие/удалённые ранее материалы (тот же алгоритм, что у{" "}
        <code>npm run content:find</code>). Статья не создаётся автоматически — только заводится в очередь.
      </p>
      {ideasLoading ? (
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>Загрузка…</div>
      ) : filteredIdeas.length === 0 ? (
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>Пока нет тем в очереди по выбранному фильтру.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visibleIdeas.map((idea) => (
            <IdeaRow
              key={idea.id}
              idea={idea}
              categoryTitleBySlug={categoryTitleBySlug}
              accessToken={accessToken}
              onChanged={onIdeasChanged}
              publishedMatch={findPublishedMatch(idea)}
              onOpenJob={onOpenJob}
            />
          ))}
          {hasMoreIdeas && (
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              style={{ ...HUB_SECONDARY_BTN, alignSelf: "flex-start" }}
            >
              Показать ещё ({filteredIdeas.length - visibleIdeas.length})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function JobScreen({
  jobId, accessToken, onClose, onIdeasChanged,
}: {
  jobId: string; accessToken: string | null; onClose: () => void; onIdeasChanged: () => void;
}) {
  const [job, setJob] = useState<any | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [advancing, setAdvancing] = useState(false);
  const [revisionText, setRevisionText] = useState("");
  const [actionError, setActionError] = useState("");
  // 3-уровневый экран производства (п.5 ТЗ «AI-редакция: самостоятельность и
  // новая навигация») — справа по умолчанию виден ТОЛЬКО итог (готово/готово
  // с замечаниями/нужен человек) + главное действие. Всё остальное
  // (замечания медпроверки, источники, история и стоимость по этапам, форма
  // доработки) — за отдельными переключателями ниже, не показывается
  // одновременно (иначе это "панель разработчика", а не результат для
  // человека — прямой запрет ТЗ).
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showRevision, setShowRevision] = useState(false);
  // Этап 6, Часть 6 ТЗ — два дополнительных сворачиваемых блока: "промпты"
  // (что реально было отправлено AI на каждом этапе — content_job_runs.input
  // уже сохраняет это, просто раньше нигде не показывалось) и "логи" (статус/
  // ошибка каждого вызова — тоже уже есть в runs, отдельная секция от
  // "Истории производства", которая показывает только человекочитаемое
  // резюме).
  const [showPrompts, setShowPrompts] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  // ТЗ "Editorial Engine 2.0", п.7 "Карточка материала — центр управления" —
  // "заметки редактора" (свободный текст для себя/коллег, НЕ инструкция для
  // AI — та уже существует выше как revisionText/"Задание на доработку").
  // Хранится в content_jobs.editor_notes (миграция 018), API — notes.ts.
  const [showNotes, setShowNotes] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSavedAt, setNotesSavedAt] = useState<number | null>(null);
  const notesInitializedRef = React.useRef(false);
  // ТЗ "Editorial Engine 2.0 — автономный конвейер" (16.07.2026) —
  // переключатель режима подтверждения публикации для ЭТОГО материала
  // (content_jobs.auto_publish, миграция 019). savingAutoPublish защищает
  // от двойного клика, пока запрос ещё выполняется.
  const [savingAutoPublish, setSavingAutoPublish] = useState(false);
  const stoppedRef = React.useRef(false);

  const load = React.useCallback(async () => {
    if (!accessToken) return;
    const res = await fetch(`/api/admin/content/jobs/${jobId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await res.json();
    if (j.ok) {
      setJob(j.job);
      setRuns(j.runs ?? []);
      setSources(j.sources ?? []);
      // Заметки редактора подгружаем только один раз при первой загрузке —
      // иначе периодический автообновляющийся poll (см. эффект ниже) стирал
      // бы то, что человек как раз сейчас набирает в textarea.
      if (!notesInitializedRef.current) {
        notesInitializedRef.current = true;
        setNotesText(j.job.editor_notes ?? "");
      }
    }
    setLoading(false);
    return j.ok ? j.job : null;
  }, [accessToken, jobId]);

  // ТЗ п.7 — сохранение заметок редактора (POST .../jobs/[id]/notes). Не
  // влияет на производство/статус — это чисто справочное поле для людей.
  async function saveNotes() {
    if (!accessToken) return;
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/admin/content/jobs/${jobId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ notes: notesText }),
      });
      const j = await res.json();
      if (j.ok) {
        setNotesSavedAt(Date.now());
        setJob((prev: any) => (prev ? { ...prev, editor_notes: notesText } : prev));
      }
    } finally {
      setSavingNotes(false);
    }
  }

  // ТЗ "Editorial Engine 2.0 — автономный конвейер" — POST .../auto-publish
  // { autoPublish }. Меняет content_jobs.auto_publish для ЭТОГО материала;
  // сам конвейер (run-stage.ts, ветка seo_review) читает это поле только
  // когда реально доходит до финальной проверки, поэтому смена значения
  // прямо сейчас ничего не публикует и не останавливает.
  async function toggleAutoPublish(next: boolean) {
    if (!accessToken) return;
    setSavingAutoPublish(true);
    try {
      const res = await fetch(`/api/admin/content/jobs/${jobId}/auto-publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ autoPublish: next }),
      });
      const j = await res.json();
      if (j.ok) setJob((prev: any) => (prev ? { ...prev, auto_publish: next } : prev));
    } finally {
      setSavingAutoPublish(false);
    }
  }

  useEffect(() => {
    stoppedRef.current = false;
    load();
    return () => {
      stoppedRef.current = true;
    };
  }, [load]);

  // ТЗ "Аудит AI-производства и автономная очередь" — этот эффект РАНЬШЕ
  // сам дёргал POST /advance по таймеру, пока экран job'а был открыт в
  // браузере: это и был единственный "двигатель" производства во всей
  // системе. Закрыли вкладку/обновили страницу — job замирал навсегда,
  // никакого фонового процесса не существовало (см. отчёт по аудиту).
  //
  // Реальный двигатель теперь — автономный серверный воркер
  // (scripts/worker/queue-worker.ts, отдельный процесс PM2), который сам,
  // независимо от браузера, опрашивает content_jobs и выполняет этапы —
  // даже если админка закрыта неделю. Админка (этот компонент) ТЕПЕРЬ
  // ТОЛЬКО читает состояние (GET .../jobs/[id]) и обновляет экран по
  // таймеру, пока job не в терминальном состоянии — чтобы администратор
  // видел прогресс воркера в реальном времени, не обновляя страницу
  // вручную. Ни одного запроса, продвигающего производство, здесь больше
  // нет — открытие/закрытие этого экрана не влияет на скорость обработки.
  useEffect(() => {
    if (!job) return;

    const isTerminal =
      !ADVANCEABLE_JOB_STATUSES.has(job.status) &&
      job.status !== "needs_decision" &&
      job.status !== "paused";
    // needs_decision/paused тоже перестают опрашиваться сами по себе — это
    // уже решение человека (кнопки ниже), автономный воркер эти статусы не
    // трогает, поэтому опрашивать их по таймеру бессмысленно.
    if (isTerminal && !job.active_stage) return;

    const t = setTimeout(() => { if (!stoppedRef.current) load(); }, 3000);
    return () => clearTimeout(t);
  }, [job?.status, job?.current_stage, job?.active_stage, load]);

  // Багфикс «кнопки решения не реагируют» (аудит: п.5-6 задачи) — раньше
  // decide()/extendBudget()/submitRevision() при отсутствующем accessToken
  // молча делали `return` без единого визуального следа: кнопка казалась
  // нажатой (курсор менялся), но ни запрос не уходил, ни ошибка не
  // показывалась. Теперь отсутствие токена — тоже видимая ошибка, а не
  // тихий no-op.
  function requireAccessToken(): boolean {
    if (accessToken) return true;
    setActionError("Сессия не найдена — обновите страницу и войдите заново.");
    return false;
  }

  async function extendBudget() {
    if (!requireAccessToken()) return;
    setAdvancing(true);
    setActionError("");
    try {
      const res = await fetch(`/api/admin/content/jobs/${jobId}/extend-budget`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
      const j = await res.json();
      if (!j.ok) {
        setActionError(j.error ?? "Не удалось продлить бюджет");
        return;
      }
      await load();
    } finally {
      setAdvancing(false);
    }
  }

  async function submitRevision() {
    if (!requireAccessToken()) return;
    if (!revisionText.trim()) {
      setActionError("Опишите, что нужно доработать, прежде чем отправлять AI.");
      return;
    }
    setAdvancing(true);
    setActionError("");
    try {
      const res = await fetch(`/api/admin/content/jobs/${jobId}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ instruction: revisionText.trim() }),
      });
      const j = await res.json();
      if (!j.ok) {
        setActionError(j.error ?? "Не удалось выполнить доработку");
        return;
      }
      setRevisionText("");
      await load();
      onIdeasChanged();
    } finally {
      setAdvancing(false);
    }
  }

  // Действия, после которых материал ПОКИДАЕТ рабочий стол этой задачи
  // (терминальные для текущей сессии решения) — только тогда экран сам
  // возвращает администратора в AI-редакцию (см. манильный чеклист:
  // "после успешного действия пользователь автоматически возвращается").
  // "return" (вернуть на доработку) — намеренно НЕ в этом списке: материал
  // продолжает жить на этом же экране, просто заново проходит черновик/
  // медпроверку.
  // Этап 7 (Часть 13 ТЗ, "честная публикация"): "publish" НЕ закрывает экран
  // — после коммита статус становится 'deploying' ("Ожидается сборка
  // сайта"), не 'published', поэтому администратор остаётся на этом же
  // экране и видит кнопку "Проверить публикацию" (см. checkDeploy ниже).
  const CLOSES_SCREEN_ACTIONS = new Set(["reject", "archive"]);
  const [deployChecking, setDeployChecking] = useState(false);

  async function checkDeploy(markFailed = false) {
    if (!requireAccessToken()) return;
    setDeployChecking(true);
    setActionError("");
    try {
      const res = await fetch(`/api/admin/content/jobs/${jobId}/check-deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(markFailed ? { action: "mark_failed" } : { action: "check" }),
      });
      const j = await res.json();
      if (!j.ok) {
        setActionError(j.error ?? "Не удалось проверить публикацию");
        return;
      }
      await load();
    } finally {
      setDeployChecking(false);
    }
  }

  // ТЗ "после успешного fetch публичного URL автоматически переводить job из
  // deploying в published" — check-deploy.ts УЖЕ сам делает этот переход при
  // успешном fetch (см. его логику: live===true → status: 'published'), не
  // хватало только автоматического ТРИГГЕРА этого fetch — раньше он запускался
  // строго по клику "Проверить публикацию". Здесь — чисто клиентский поллинг
  // того же самого честного check-deploy эндпоинта, пока job в статусе
  // 'deploying'; сам publish pipeline (decision.ts) не тронут ни строкой.
  // Ручные кнопки "Проверить публикацию"/"Пометить как ошибку сборки"
  // остаются рабочими как есть — это не замена, а дополнение.
  useEffect(() => {
    if (job?.status !== "deploying") return;
    let cancelled = false;
    const intervalId = setInterval(() => {
      if (cancelled || deployChecking) return;
      checkDeploy(false);
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, jobId, accessToken]);

  async function decide(action: "publish" | "return" | "reject" | "archive") {
    if (!requireAccessToken()) return;
    setAdvancing(true);
    setActionError("");
    try {
      const res = await fetch(`/api/admin/content/jobs/${jobId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action }),
      });
      const j = await res.json();
      if (!j.ok) {
        setActionError(j.error ?? "Не удалось выполнить действие");
        return;
      }
      // Багфикс: раньше hub обновлялся (onIdeasChanged) только для "reject",
      // остальные решения меняют счётчики В работе/Готово/Архив в хабе точно
      // так же, но статистика оставалась устаревшей, пока кто-то вручную не
      // обновлял страницу.
      onIdeasChanged();
      if (CLOSES_SCREEN_ACTIONS.has(action)) {
        onClose();
        return;
      }
      await load();
    } finally {
      setAdvancing(false);
    }
  }

  // ТЗ "Аудит AI-производства и автономная очередь" — "позволять повторить
  // упавшее задание" (единственное производственное действие, оставленное
  // админке, помимо чтения статуса). Вызывает /retry-stage, НЕ /advance:
  // сам этап синхронно НЕ выполняется этим запросом — он только снимает
  // пометку needs_decision/failure_kind и возвращает job в тот статус, из
  // которого автономный воркер (или explicit "Проверить состояние") сам
  // подхватит его обычным образом на следующем цикле. Разрешено только для
  // failure_kind:'infra_error' — сервер (retry-stage.ts) сам это проверяет
  // и вернёт понятную ошибку для 'content_review'.
  async function retryStage() {
    if (!requireAccessToken()) return;
    setAdvancing(true);
    setActionError("");
    try {
      const res = await fetch(`/api/admin/content/jobs/${jobId}/retry-stage`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const j = await res.json();
      if (!j.ok) {
        setActionError(j.error ?? "Не удалось повторить попытку");
        return;
      }
      await load();
    } finally {
      setAdvancing(false);
    }
  }

  if (loading || !job) {
    return <Centered>Загрузка производственной задачи…</Centered>;
  }

  const stepIndex = JOB_STAGE_STEPS.findIndex((s) => s.key === job.current_stage);
  const isFinalScreen = job.current_stage === "done" && job.status === "needs_decision";
  const isProblem = job.status === "needs_decision" && !isFinalScreen;
  const isHardLimitPaused = job.status === "paused" && job.stop_reason_code === "hard_limit";
  const fm = job.draft?.frontmatter ?? null;
  const research = job.research_brief ?? null;
  const medicalReview = job.medical_review ?? null;
  const seoReview = job.seo_review ?? null;

  // ТЗ "автономное производство" — журнал решений AI (п.9): объединяем ОБЕ
  // формы medical_review в один список для отображения — старую (problems[]
  // вперемешку critical+needs_attention, до объединения медпроверки и
  // автоправки в один вызов) и новую (criticalIssues[]/warnings[] отдельно,
  // appliedFixes[] — то, что AI уже исправил САМ, без отдельного запроса).
  const legacyProblemNotes = (medicalReview?.problems ?? []).map((p: any) => ({ field: p.field, text: p.issue, extra: p.requiredChange ? `→ ${p.requiredChange}` : "", tone: p.severity === "critical" ? "critical" : "warning" }));
  const criticalNotes = (medicalReview?.criticalIssues ?? []).map((p: any) => ({ field: p.field, text: p.issue, extra: p.originalFragment ? `«${p.originalFragment}»` : "", tone: "critical" as const }));
  const warningNotes = (medicalReview?.warnings ?? []).map((p: any) => ({ field: p.field, text: p.issue, extra: "", tone: "warning" as const }));
  const appliedFixNotes = (medicalReview?.appliedFixes ?? []).map((p: any) => ({ field: p.field, text: `✓ Исправлено автоматически: ${p.reason ?? ""}`, extra: p.newValue ? `→ «${p.newValue}»` : "", tone: "applied" as const }));
  const allMedicalNotes = [...criticalNotes, ...warningNotes, ...appliedFixNotes, ...legacyProblemNotes];

  // Этап 3.2 — сводка стоимости/времени (п.4/16/18 ТЗ), считается на лету из runs, ничего не дублируется на клиенте.
  const costSummary = computeJobCostSummary(runs);
  // ТЗ "Editorial Engine 2.0", п.7 — "какая AI-модель используется".
  // content_job_runs.model существовал с самого начала (миграция 007), но
  // нигде не читался; runs здесь уже отсортированы по started_at (см.
  // jobs/[id].ts), поэтому последняя запись с непустым model — самая свежая.
  const lastModel = [...runs].reverse().find((r: any) => r.model)?.model as string | undefined;
  const budgetLimit = Number(job.budget_limit_usd ?? 1.25);
  const runningStage = job.active_stage ? (STAGE_RUN_LABELS[job.active_stage] ?? job.active_stage) : null;
  const runningSinceMs = job.active_run_started_at ? Date.now() - new Date(job.active_run_started_at).getTime() : 0;

  // Единая модель итога (п.6, 133 в финальном отчёте) — тот же
  // computeJobOutcome/summarizeOutcome, что и в advance.ts и в хабе, чтобы
  // бейдж здесь никогда не расходился с тем, что показывает "В работе".
  const outcome = computeJobOutcome(job);
  const outcomeLabel = OUTCOME_LABELS[outcome];
  const outcomeColor = OUTCOME_COLORS[outcome];

  return (
    <div>
      {/* Хлебные крошки — п.10 ТЗ: раньше "Назад к контент-плану" вело не
          туда, откуда реально открыли производство. Теперь всегда один и тот
          же путь назад, независимо от точки входа. */}
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 12, display: "flex", alignItems: "center", gap: 4 }}>
        <a href="/admin/editorial" style={{ color: "var(--color-brand-blue)", textDecoration: "none" }}>AI-редакция</a>
        <span>/</span>
        <a href="/admin/editorial/jobs" style={{ color: "var(--color-brand-blue)", textDecoration: "none" }}>Производство</a>
        <span>/</span>
        <span style={{ color: "var(--color-text)" }}>{job.title}</span>
      </div>

      {/* Верхняя полоса — п.5(a) ТЗ: заголовок + подзаголовок (этап · время ·
          стоимость · вызовы) + итоговый бейдж справа. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        <div>
          <div style={{ fontSize: "var(--font-size-lg)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)" }}>{job.title}</div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)", marginTop: 2 }}>
            {advancing ? "Выполняется…" : STAGE_RUN_LABELS[job.current_stage] ?? JOB_STATUS_LABELS[job.status] ?? job.status}
            {" · "}{fmtDurationShort(costSummary.totalDurationMs)} · {fmtCost(costSummary.totalCostUsd)} · {costSummary.totalCalls} AI-вызов{costSummary.totalCalls === 1 ? "" : "а"}
            {job.category ? ` · ${job.category}` : ""}
            {/* ТЗ п.7 "Карточка материала" — "какая AI-модель используется" */}
            {lastModel ? ` · ${lastModel}` : ""}
          </div>
        </div>
        <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-semibold)", color: outcomeColor, whiteSpace: "nowrap", padding: "4px 10px", borderRadius: "var(--radius-md)", border: `1px solid ${outcomeColor}` }}>
          {outcomeLabel}
        </div>
      </div>

      {/* Линия прогресса — п.5(b) ТЗ: показывает ИСТОРИЮ, не 5 обязательных
          кнопок. Каждый этап кликабелен и разворачивает свои реальные
          запуски (runs) под строкой — вместо того чтобы всегда держать
          "Расходы и вызовы"/"История" развёрнутыми на весь экран. */}
      <div style={{ display: "flex", gap: 4, marginBottom: "var(--space-2)", flexWrap: "wrap" }}>
        {JOB_STAGE_STEPS.map((step, i) => {
          const done = i < stepIndex || (i === stepIndex && step.key === "done");
          const active = i === stepIndex && step.key !== "done";
          return (
            <button
              key={step.key}
              onClick={() => setExpandedStage(expandedStage === step.key ? null : step.key)}
              style={{
                fontSize: "var(--font-size-xs)",
                fontWeight: active ? "var(--font-weight-semibold)" : "var(--font-weight-medium)",
                padding: "6px 10px",
                borderRadius: "var(--radius-md)",
                border: expandedStage === step.key ? "2px solid var(--color-text)" : "none",
                background: done ? "var(--color-severity-low)" : active ? "var(--color-brand-blue)" : "var(--color-neutral-100)",
                color: done || active ? "#fff" : "var(--color-text-secondary)",
                cursor: "pointer",
              }}
            >
              {i + 1}. {step.label}
            </button>
          );
        })}
      </div>

      {/* ТЗ "Editorial Engine 2.0", п.4 "Единый Pipeline" — просит явно
          отдельный узел "Publishing", отличный от "Completed" (Idea→
          Research→Planning→Draft→Validation→SEO→Publishing→Completed).
          JOB_STAGE_STEPS выше заканчивается на "done" (соответствует Draft-
          через-SEO пройдены), а сама публикация — отдельный под-конвейер
          поверх status (validating/committing/deploying/published), который
          не умещается в один current_stage. Показываем его отдельной
          строкой, только когда материал этого этапа уже достиг — ничего не
          меняем в самих значениях stage/status, это чисто визуальная
          надстройка. */}
      {job.current_stage === "done" && (
        <div style={{ display: "flex", gap: 4, marginBottom: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>Публикация:</span>
          {PUBLISH_SUBSTEPS.map((s) => {
            const publishStepIndex = PUBLISH_SUBSTEPS.findIndex((x) => x.statuses.includes(job.status));
            const thisIndex = PUBLISH_SUBSTEPS.indexOf(s);
            const done = publishStepIndex >= 0 && thisIndex < publishStepIndex;
            const active = s.statuses.includes(job.status);
            const failed = active && FAILED_STATUSES.has(job.status);
            return (
              <span
                key={s.label}
                style={{
                  fontSize: "var(--font-size-xs)",
                  fontWeight: active ? "var(--font-weight-semibold)" : "var(--font-weight-medium)",
                  padding: "4px 8px",
                  borderRadius: "var(--radius-md)",
                  background: failed ? "var(--color-brand-red)" : done ? "var(--color-severity-low)" : active ? "var(--color-brand-blue)" : "var(--color-neutral-100)",
                  color: done || active ? "#fff" : "var(--color-text-secondary)",
                }}
              >
                {s.label}
              </span>
            );
          })}
        </div>
      )}

      {expandedStage && (
        <div style={{ background: "var(--color-neutral-100)", borderRadius: "var(--radius-md)", padding: "8px 12px", marginBottom: "var(--space-3)", fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
          {(() => {
            const stageRuns = runs.filter((r: any) => r.stage === expandedStage || (expandedStage === "draft" && r.stage === "point_fix"));
            if (stageRuns.length === 0) return <span>Этап ещё не выполнялся.</span>;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {stageRuns.map((r: any) => (
                  <div key={r.id}>
                    {fmtTime(r.completed_at ?? r.started_at)} — {STAGE_RUN_LABELS[r.stage] ?? r.stage}
                    {r.status === "ok" ? " завершена" : r.status === "needs_decision" ? ": нужна проверка человеком" : ": ошибка"}
                    {" · "}{fmtDurationShort(r.duration_ms ?? 0)} · {fmtCost(r.cost_usd ?? 0)}
                    {r.error && <span> ({humanizeError(r.error).summary})</span>}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
      {runningStage && (
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-blue)", fontWeight: "var(--font-weight-medium)", marginBottom: "var(--space-3)" }}>
          {runningStage} выполняется{runningSinceMs > 0 ? ` — ${fmtDurationShort(runningSinceMs)} назад` : ""}
        </div>
      )}

      {actionError && (
        <div style={{ background: "var(--color-bg-danger)", border: "1px solid var(--color-border-danger)", borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-3)", fontSize: "var(--font-size-xs)", marginBottom: "var(--space-4)" }}>
          {actionError}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: "var(--space-5)", alignItems: "start" }}>
        {/* Слева — материал */}
        <div id="job-current-draft" style={{ background: "#fff", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
          {!fm ? (
            <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>
              {advancing ? "Черновик ещё готовится…" : "Черновика пока нет."}
            </div>
          ) : (
            <>
              <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", marginBottom: 8 }}>{fm.title}</div>
              <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text)" }}>{fm.shortAnswer}</p>
              {fm.whatIsIt && (
                <DraftSection title="Qué es">
                  <li>{fm.whatIsIt}</li>
                </DraftSection>
              )}
              {fm.whatIsItFor?.length > 0 && (
                <DraftSection title="Para qué sirve">
                  {fm.whatIsItFor.map((p: string, i: number) => <li key={i}>{p}</li>)}
                </DraftSection>
              )}
              {fm.benefits?.length > 0 && (
                <DraftSection title="Beneficios">
                  {fm.benefits.map((p: string, i: number) => <li key={i}>{p}</li>)}
                </DraftSection>
              )}
              {fm.deficiencySigns?.length > 0 && (
                <DraftSection title="Señales de déficit">
                  {fm.deficiencySigns.map((p: string, i: number) => <li key={i}>{p}</li>)}
                </DraftSection>
              )}
              {fm.excessSigns?.length > 0 && (
                <DraftSection title="Señales de exceso">
                  {fm.excessSigns.map((p: string, i: number) => <li key={i}>{p}</li>)}
                </DraftSection>
              )}
              {fm.foodSources?.length > 0 && (
                <DraftSection title="Fuentes en la comida">
                  {fm.foodSources.map((p: string, i: number) => <li key={i}>{p}</li>)}
                </DraftSection>
              )}
              {fm.dailyIntake?.length > 0 && (
                <DraftSection title="Dosis diaria">
                  {fm.dailyIntake.map((p: string, i: number) => <li key={i}>{p}</li>)}
                </DraftSection>
              )}
              {fm.supplementForms?.length > 0 && (
                <DraftSection title="Formas en suplementos">
                  {fm.supplementForms.map((p: string, i: number) => <li key={i}>{p}</li>)}
                </DraftSection>
              )}
              {fm.contraindications?.length > 0 && (
                <DraftSection title="Contraindicaciones" tone="critical">
                  {fm.contraindications.map((p: string, i: number) => <li key={i}>{p}</li>)}
                </DraftSection>
              )}
              {fm.faq?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-semibold)", marginBottom: 6 }}>FAQ</div>
                  {fm.faq.map((f: any, i: number) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)" }}>{f.q}</div>
                      <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>{f.a}</div>
                    </div>
                  ))}
                </div>
              )}
              {job.draft?.body && (
                <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "var(--font-size-sm)", color: "var(--color-text)", marginTop: 12, borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
                  {job.draft.body}
                </pre>
              )}
            </>
          )}
        </div>

        {/* Справа — ЕДИНСТВЕННАЯ панель итога (п.5(c) ТЗ). Одновременно
            видно только текущее состояние + главное действие — медицинская
            проверка/источники/история/доработка спрятаны за ссылками ниже,
            открываются по одной, а не все разом ("панель разработчика"
            прямо запрещена ТЗ). */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div style={{ background: "#fff", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
            {isHardLimitPaused && (
              <div style={{ fontSize: "var(--font-size-sm)" }}>
                <div style={{ color: "var(--color-brand-red)", fontWeight: "var(--font-weight-medium)", marginBottom: 6 }}>Производство приостановлено</div>
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 10 }}>{job.decision_reason}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={extendBudget} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}>
                    Продолжить ещё на $0.50
                  </button>
                  <a href={`#job-current-draft`} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer", textDecoration: "none", color: "var(--color-text)", display: "inline-flex", alignItems: "center" }}>
                    Открыть текущий результат
                  </a>
                  <button onClick={() => decide("archive")} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", color: "var(--color-brand-red)", cursor: "pointer" }}>
                    Остановить производство
                  </button>
                </div>
              </div>
            )}

            {/* "Готово"/"Готово с замечаниями" — п.6, 9 ТЗ: только ОДНО
                главное действие ярко выделено ("Опубликовать"), остальное —
                вторично. Текст берётся из summarizeOutcome — та же формула,
                что и в advance.ts/хабе (одно и то же резюме везде). */}
            {/* Этап 6, Часть 1+3 ТЗ: ОДНО реальное действие "Опубликовать" —
                строит .mdx, коммитит в GitHub атомарно (.mdx + Registry ID),
                и статус меняется на "Опубликовано" ТОЛЬКО если коммит
                реально прошёл (см. decision.ts). Раньше здесь был "approve",
                который лишь готовил текст и открывал ВТОРОЙ экран с ручной
                инструкцией "скопируйте файл сами" — эта фиктивная ступень
                убрана целиком. legacy-статус "approved" обрабатывается тем
                же условием ниже (canPublishNow), чтобы старые материалы,
                утверждённые до этого рефакторинга, тоже могли реально
                опубликоваться, а не зависнуть на пустом экране. */}
            {!isHardLimitPaused && (isFinalScreen || job.status === "approved") && (
              <div style={{ fontSize: "var(--font-size-sm)" }}>
                <div style={{ color: outcomeColor, fontWeight: "var(--font-weight-semibold)", marginBottom: 6 }}>{outcomeLabel}</div>
                <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", margin: "0 0 12px" }}>{summarizeOutcome(job)}</p>
                {job.publish_stage_failed && (
                  <div style={{ background: "var(--color-bg-danger)", border: "1px solid var(--color-border-danger)", borderRadius: "var(--radius-md)", padding: "8px 10px", fontSize: "var(--font-size-xs)", marginBottom: 10 }}>
                    Предыдущая попытка публикации остановилась на этапе «{job.publish_stage_failed}»: {job.decision_reason}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => decide("publish")} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}>
                    {job.publish_stage_failed ? "Повторить публикацию" : outcome === "done_with_notes" ? "Опубликовать с замечаниями" : "Опубликовать"}
                  </button>
                  {/* ТЗ п.11: "Доработать через AI" — быстрый доступ к тому же
                      заданию на доработку, что и ссылка "Задание на доработку
                      для AI" ниже (тот же submitRevision/revise.ts) — просто
                      сразу раскрывает форму, не заставляя искать её внизу. */}
                  <button onClick={() => setShowRevision(true)} disabled={advancing} style={{ fontSize: "11px", padding: "4px 8px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", color: "var(--color-text)", cursor: "pointer" }}>
                    Доработать через AI
                  </button>
                  <button onClick={() => decide("return")} disabled={advancing} style={{ fontSize: "11px", padding: "4px 8px", borderRadius: "var(--radius-md)", border: "none", background: "none", color: "var(--color-text-secondary)", cursor: "pointer" }}>
                    Вернуть на доработку
                  </button>
                  <button onClick={() => decide("reject")} disabled={advancing} style={{ fontSize: "11px", padding: "4px 8px", borderRadius: "var(--radius-md)", border: "none", background: "none", color: "var(--color-brand-red)", cursor: "pointer" }}>
                    Отклонить
                  </button>
                  {advancing && <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>Публикуем…</span>}
                </div>
              </div>
            )}

            {/* "Нужен человек" — единственный случай, когда AI реально
                остановил производство (п.6 ТЗ). */}
            {isProblem && (
              <div style={{ fontSize: "var(--font-size-sm)" }}>
                <div style={{ color: "var(--color-brand-red)", fontWeight: "var(--font-weight-semibold)", marginBottom: 6 }}>Нужен человек</div>
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>{job.decision_reason}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  {/* ТЗ "позволять повторить упавшее задание" — только для
                      технических сбоев (лимит попыток исчерпан на связи с
                      AI и т.п.), НЕ для content_review (реальная медицинская/
                      SEO проблема — там повтор не поможет, нужно решение
                      ниже). Само задание НЕ обрабатывается тут же — просто
                      снимает пометку, дальше подхватит автономный воркер. */}
                  {job.failure_kind === "infra_error" && (
                    <button onClick={() => retryStage()} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-severity-low)", color: "#fff", cursor: "pointer" }}>
                      Повторить
                    </button>
                  )}
                  <button onClick={() => decide("return")} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}>
                    Вернуть на доработку
                  </button>
                  <button onClick={() => decide("reject")} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", color: "var(--color-brand-red)", cursor: "pointer" }}>
                    Отклонить
                  </button>
                  <button onClick={() => decide("archive")} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
                    В архив
                  </button>
                  {advancing && <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>Сохраняем…</span>}
                </div>
              </div>
            )}

            {/* Публикационный pipeline (новое ТЗ п.5-6) — сбой ДО коммита
                (validation_failed) или самого коммита (commit_failed).
                Отдельная панель, не смешанная с медицинским outcome-бейджем
                выше: тут причина сбоя чисто техническая/публикационная, не
                про содержание медпроверки. "Повторить публикацию" работает
                (см. RESUMABLE_PUBLISH_STATUSES в decision.ts) — job не
                зависает, как раньше зависал AI-стратег в похожей ситуации. */}
            {(job.status === "validation_failed" || job.status === "commit_failed") && (
              <div style={{ fontSize: "var(--font-size-sm)" }}>
                <div style={{ color: "var(--color-brand-red)", fontWeight: "var(--font-weight-medium)", marginBottom: 4 }}>
                  {job.status === "validation_failed" ? "Не прошла проверку перед публикацией" : "Ошибка коммита в GitHub"}
                </div>
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 10 }}>
                  {job.publish_stage_failed && <>Этап: {job.publish_stage_failed}<br /></>}
                  {job.decision_reason}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => decide("publish")} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}>
                    {advancing ? "Публикуем…" : "Повторить публикацию"}
                  </button>
                  <button onClick={() => decide("return")} disabled={advancing} style={{ fontSize: "11px", padding: "4px 8px", borderRadius: "var(--radius-md)", border: "none", background: "none", color: "var(--color-text-secondary)", cursor: "pointer" }}>
                    Вернуть на доработку
                  </button>
                </div>
              </div>
            )}

            {/* Часть 13 ТЗ ("честная публикация") — коммит прошёл, но
                статус ЕЩЁ НЕ "Опубликовано". Без Cloudflare API нельзя
                напрямую спросить статус сборки — вместо этого реальный
                HTTP-запрос к публичному URL материала (см. check-deploy.ts):
                если страница действительно отвечает и содержит заголовок,
                статус переходит в "Опубликовано" по-настоящему, а не по
                факту одного коммита. */}
            {(job.status === "deploying" || job.status === "deploy_failed") && (
              <div style={{ fontSize: "var(--font-size-sm)" }}>
                <div style={{ color: job.status === "deploy_failed" ? "var(--color-brand-red)" : "var(--color-brand-blue)", fontWeight: "var(--font-weight-medium)", marginBottom: 4 }}>
                  {job.status === "deploy_failed" ? "Ошибка сборки/деплоя" : "Публикуется — ожидается сборка сайта"}
                </div>
                {/* Ошибки Cloudflare (новое ТЗ п.7): интерфейс не должен
                    зависеть от возможности открыть Cloudflare Details —
                    все нужные для диагностики факты сохранены нами самими. */}
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: 10 }}>
                  {job.publish_registry_id && <>Registry ID: {job.publish_registry_id}<br /></>}
                  {job.publish_commit_sha && <>Коммит: {String(job.publish_commit_sha).slice(0, 7)}<br /></>}
                  {job.publish_expected_url && (
                    <>Ожидаемый URL: <a href={job.publish_expected_url} target="_blank" rel="noreferrer">{job.publish_expected_url}</a><br /></>
                  )}
                  {job.deploy_started_at && <>Коммит сделан: {fmtTime(job.deploy_started_at)}<br /></>}
                  {job.deploy_check_note ? job.deploy_check_note : "Коммит в GitHub прошёл. Cloudflare Pages должна собрать и выложить сайт за 1-2 минуты — нажмите «Проверить публикацию», чтобы подтвердить, что материал реально появился."}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => checkDeploy(false)} disabled={deployChecking} style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}>
                    {deployChecking ? "Проверяем…" : "Проверить публикацию"}
                  </button>
                  {job.status === "deploying" && (
                    <button onClick={() => checkDeploy(true)} disabled={deployChecking} style={{ fontSize: "11px", padding: "4px 8px", borderRadius: "var(--radius-md)", border: "none", background: "none", color: "var(--color-brand-red)", cursor: "pointer" }}>
                      Пометить как ошибку сборки
                    </button>
                  )}
                  {job.status === "deploy_failed" && (
                    <button onClick={() => decide("publish")} disabled={advancing} style={{ fontSize: "var(--font-size-xs)", padding: "8px 16px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>
                      Исправить и переопубликовать
                    </button>
                  )}
                </div>
              </div>
            )}

            {job.status === "published" && (
              <div style={{ fontSize: "var(--font-size-sm)" }}>
                <div style={{ color: "var(--color-severity-low)", fontWeight: "var(--font-weight-medium)", marginBottom: 4 }}>Опубликовано</div>
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
                  {job.publish_registry_id && <>Registry ID: {job.publish_registry_id}<br /></>}
                  {job.published_at && <>Опубликовано: {fmtTime(job.published_at)}<br /></>}
                  {job.publish_commit_sha && <>Коммит: {String(job.publish_commit_sha).slice(0, 7)}<br /></>}
                </div>
                <a href={job.publish_registry_id ? `/admin/content/materials/${job.publish_registry_id}` : "/admin/content"} style={{ fontSize: "var(--font-size-xs)", color: "var(--color-brand-blue)" }}>Открыть в Библиотеке →</a>
              </div>
            )}
            {job.status === "rejected" && <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>Отклонено{job.decision_reason ? `: ${job.decision_reason}` : ""}</div>}
            {job.status === "archived" && <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>В архиве</div>}
            {ADVANCEABLE_JOB_STATUSES.has(job.status) && (
              <div style={{ fontSize: "var(--font-size-xs)" }}>
                {runningStage ? (
                  <div style={{ color: runningSinceMs > (STAGE_TARGET_MS_CLIENT[job.active_stage] ?? 90_000) ? "var(--color-brand-orange, #d97706)" : "var(--color-text-secondary)" }}>
                    {runningStage} выполняется — {fmtDurationShort(runningSinceMs)}
                    {runningSinceMs > (STAGE_TARGET_MS_CLIENT[job.active_stage] ?? 90_000) && <span> (дольше ожидаемого)</span>}
                    <div style={{ marginTop: 4 }}>
                      <button onClick={() => load()} style={{ fontSize: "11px", padding: "3px 8px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}>Проверить состояние</button>
                    </div>
                  </div>
                ) : (
                  <span style={{ color: "var(--color-text-secondary)" }}>{advancing ? "AI выполняет этап…" : "Ожидание следующего шага…"}</span>
                )}
              </div>
            )}
          </div>

          {/* Второстепенные детали — п.5(c) ТЗ: "Посмотреть N замечаний" /
              "Посмотреть источники" / "История производства" / "Вернуть на
              доработку" — открываются по одной ссылке за раз, не занимают
              место, если администратору сейчас это не нужно. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--font-size-xs)" }}>
            {allMedicalNotes.length > 0 && (
              <LinkStat onClick={() => setShowProblems((v) => !v)}>
                {showProblems ? "Скрыть замечания" : `Посмотреть ${allMedicalNotes.length} замечани${allMedicalNotes.length === 1 ? "е" : allMedicalNotes.length < 5 ? "я" : "й"}`}
              </LinkStat>
            )}
            {showProblems && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflow: "auto", padding: "8px 0" }}>
                {allMedicalNotes.map((p, i) => (
                  <div key={i} style={{ borderLeft: `3px solid ${p.tone === "critical" ? "var(--color-brand-red)" : p.tone === "applied" ? "var(--color-severity-low)" : "var(--color-brand-orange, #d97706)"}`, paddingLeft: 8 }}>
                    <div style={{ fontWeight: "var(--font-weight-medium)", color: "var(--color-text)" }}>{p.field}</div>
                    <div style={{ color: "var(--color-text-secondary)" }}>{p.text}</div>
                    {p.extra && <div style={{ color: "var(--color-text)" }}>{p.extra}</div>}
                  </div>
                ))}
              </div>
            )}

            {sources.length > 0 && (
              <LinkStat onClick={() => setShowSources((v) => !v)}>
                {showSources ? "Скрыть источники" : `Посмотреть источники (${sources.length})`}
              </LinkStat>
            )}
            {showSources && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflow: "auto", padding: "8px 0" }}>
                {sources.map((s) => (
                  <div key={s.id}>
                    <a href={s.url} target="_blank" rel="noreferrer" style={{ color: "var(--color-brand-blue)" }}>{s.title}</a>
                    {s.organization && <span style={{ color: "var(--color-text-secondary)" }}> · {s.organization}</span>}
                  </div>
                ))}
                {research?.redFlags?.length > 0 && (
                  <div style={{ marginTop: 8, borderTop: "1px solid var(--color-border)", paddingTop: 8 }}>
                    <div style={{ fontWeight: "var(--font-weight-medium)", color: "var(--color-text)", marginBottom: 4 }}>Красные флаги (из исследования)</div>
                    <ul style={{ paddingLeft: 18, margin: 0 }}>
                      {research.redFlags.map((r: string, i: number) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {runs.length > 0 && (
              <LinkStat onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? "Скрыть историю производства" : "История производства"}
              </LinkStat>
            )}
            {showHistory && (
              <div style={{ padding: "8px 0" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--color-text-secondary)", maxHeight: 220, overflow: "auto" }}>
                  {runs.map((r) => (
                    <div key={r.id}>
                      {fmtTime(r.completed_at ?? r.started_at)} — {STAGE_RUN_LABELS[r.stage] ?? r.stage}
                      {r.status === "ok" ? " завершена" : r.status === "needs_decision" ? ": нужна проверка человеком" : ": ошибка"}
                      {r.error && <span> ({humanizeError(r.error).summary})</span>}
                    </div>
                  ))}
                </div>

                {/* Стоимость и время по этапам — п.12 ТЗ: доступно по клику, не доминирует над интерфейсом. */}
                <details style={{ marginTop: 10, borderTop: "1px solid var(--color-border)", paddingTop: 8 }}>
                  <summary style={{ cursor: "pointer", color: "var(--color-brand-blue)" }}>Расходы по этапам</summary>
                  <table style={{ width: "100%", fontSize: "11px", marginTop: 8, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
                        <th style={{ padding: "2px 4px" }}>Этап</th>
                        <th style={{ padding: "2px 4px" }}>Вызовов</th>
                        <th style={{ padding: "2px 4px" }}>Время</th>
                        <th style={{ padding: "2px 4px" }}>Input</th>
                        <th style={{ padding: "2px 4px" }}>Output</th>
                        <th style={{ padding: "2px 4px" }}>Стоимость</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(costSummary.perStage.entries()).map(([stage, s]: [string, any]) => (
                        <tr key={stage} style={{ borderTop: "1px solid var(--color-border)" }}>
                          <td style={{ padding: "3px 4px" }}>{STAGE_RUN_LABELS[stage] ?? stage}</td>
                          <td style={{ padding: "3px 4px" }}>{s.calls}</td>
                          <td style={{ padding: "3px 4px" }}>{fmtDurationShort(s.durationMs)}</td>
                          <td style={{ padding: "3px 4px" }}>{(s.inputTokens / 1000).toFixed(1)}K</td>
                          <td style={{ padding: "3px 4px" }}>{(s.outputTokens / 1000).toFixed(1)}K</td>
                          <td style={{ padding: "3px 4px" }}>{fmtCost(s.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 6, fontWeight: "var(--font-weight-medium)" }}>
                    Итого: {costSummary.totalCalls} вызовов · {(costSummary.totalInputTokens / 1000).toFixed(1)}K input · {(costSummary.totalOutputTokens / 1000).toFixed(1)}K output · ~{fmtCost(costSummary.totalCostUsd)}
                  </div>
                </details>
              </div>
            )}

            {/* "Промпты" (Этап 6, Часть 6 ТЗ) — что реально ушло в AI на каждом
                этапе. content_job_runs.input уже хранит это (структурированный
                контекст, переданный callEditorStage), просто раньше нигде не
                отображался. */}
            {runs.length > 0 && (
              <LinkStat onClick={() => setShowPrompts((v) => !v)}>
                {showPrompts ? "Скрыть промпты" : "Промпты"}
              </LinkStat>
            )}
            {showPrompts && (
              <div style={{ padding: "8px 0", display: "flex", flexDirection: "column", gap: 8 }}>
                {runs.map((r) => (
                  <details key={r.id}>
                    <summary style={{ cursor: "pointer", color: "var(--color-brand-blue)", fontSize: "11px" }}>
                      {fmtTime(r.completed_at ?? r.started_at)} — {STAGE_RUN_LABELS[r.stage] ?? r.stage} (попытка {r.attempt})
                    </summary>
                    <pre style={{ fontSize: "11px", whiteSpace: "pre-wrap", background: "var(--color-neutral-100)", padding: 8, borderRadius: "var(--radius-md)", maxHeight: 240, overflow: "auto", marginTop: 4 }}>
                      {JSON.stringify(r.input ?? {}, null, 2)}
                    </pre>
                  </details>
                ))}
              </div>
            )}

            {/* "Логи" (Этап 6, Часть 6 ТЗ) — сырой статус/ошибка/выход каждого
                вызова, отдельно от человекочитаемого резюме в "Истории
                производства" выше — для диагностики, если что-то пошло не так. */}
            {runs.length > 0 && (
              <LinkStat onClick={() => setShowLogs((v) => !v)}>
                {showLogs ? "Скрыть логи" : "Логи"}
              </LinkStat>
            )}
            {showLogs && (
              <div style={{ padding: "8px 0", display: "flex", flexDirection: "column", gap: 8 }}>
                {runs.map((r) => (
                  <div key={r.id} style={{ fontSize: "11px", background: "var(--color-neutral-100)", borderRadius: "var(--radius-md)", padding: 8 }}>
                    <div style={{ fontWeight: "var(--font-weight-medium)", color: "var(--color-text)" }}>
                      {STAGE_RUN_LABELS[r.stage] ?? r.stage} · попытка {r.attempt} · {r.status} · {fmtTime(r.completed_at ?? r.started_at)}
                    </div>
                    {r.error && (
                      <div style={{ color: "var(--color-brand-red)", marginTop: 2 }}>
                        {humanizeError(r.error).summary}
                        <span style={{ color: "var(--color-text-secondary)" }}> · {r.error}</span>
                      </div>
                    )}
                    <div style={{ color: "var(--color-text-secondary)", marginTop: 2 }}>
                      {r.duration_ms != null ? `${r.duration_ms} мс · ` : ""}
                      {r.usage_input_tokens != null ? `${r.usage_input_tokens} input / ${r.usage_output_tokens ?? 0} output токенов` : "нет данных usage"}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Задание на доработку — свободный текст для AI (п.7 ТЗ Этапа 3.2), отдельно от кнопки "Вернуть на доработку" в главной панели. */}
            {job.draft && !["published", "rejected", "archived"].includes(job.status) && (
              <LinkStat onClick={() => setShowRevision((v) => !v)}>
                {showRevision ? "Скрыть форму доработки" : "Задание на доработку для AI"}
              </LinkStat>
            )}
            {showRevision && (
              <div style={{ padding: "8px 0" }}>
                <textarea
                  value={revisionText}
                  onChange={(e) => setRevisionText(e.target.value)}
                  placeholder="Например: сделай раздел о причинах короче"
                  rows={3}
                  style={{ width: "100%", fontSize: "var(--font-size-sm)", padding: 8, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", fontFamily: "inherit", resize: "vertical" }}
                />
                <button
                  onClick={submitRevision}
                  disabled={advancing || !revisionText.trim()}
                  style={{ marginTop: 8, fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-brand-blue)", color: "#fff", cursor: "pointer" }}
                >
                  Отправить AI
                </button>
                <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: 6 }}>Изменение текста автоматически возвращает материал на медицинскую проверку.</p>
              </div>
            )}

            {/* ТЗ "Editorial Engine 2.0", п.7 "Карточка материала — центр
                управления" — "комментарии редактора". Свободный текст ТОЛЬКО
                для людей (себя/коллег) — в отличие от формы выше это НЕ
                инструкция для AI и не запускает никакой этап. */}
            <LinkStat onClick={() => setShowNotes((v) => !v)}>
              {showNotes ? "Скрыть заметки редактора" : job.editor_notes ? "Заметки редактора ✎" : "Добавить заметку редактора"}
            </LinkStat>
            {showNotes && (
              <div style={{ padding: "8px 0" }}>
                <textarea
                  value={notesText}
                  onChange={(e) => { setNotesText(e.target.value); setNotesSavedAt(null); }}
                  placeholder="Например: проверить дозировки ещё раз перед публикацией"
                  rows={3}
                  style={{ width: "100%", fontSize: "var(--font-size-sm)", padding: 8, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", fontFamily: "inherit", resize: "vertical" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <button
                    onClick={saveNotes}
                    disabled={savingNotes}
                    style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}
                  >
                    {savingNotes ? "Сохранение…" : "Сохранить заметку"}
                  </button>
                  {notesSavedAt && <span style={{ fontSize: "11px", color: "var(--color-severity-low)" }}>Сохранено</span>}
                </div>
              </div>
            )}

            {/* ТЗ "Editorial Engine 2.0 — автономный конвейер" — переключатель
                режима подтверждения. По умолчанию включена автопубликация
                (весь конвейер до published без остановки); выключение —
                явный выбор человека остановиться на needs_decision перед
                публикацией именно для этого материала. */}
            {!["published", "rejected", "archived"].includes(job.status) && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", cursor: savingAutoPublish ? "default" : "pointer" }}>
                <input
                  type="checkbox"
                  checked={job.auto_publish !== false}
                  disabled={savingAutoPublish}
                  onChange={(e) => toggleAutoPublish(e.target.checked)}
                />
                Автопубликация без остановки на подтверждение
                {job.auto_publish === false && <span style={{ color: "var(--color-brand-blue)" }}> (включён ручной режим для этого материала)</span>}
              </label>
            )}

            {/* ТЗ п.7 — "связанные материалы": manualRelated из frontmatter —
                единственный уже существующий на клиенте источник этой связи
                (см. schema/config.ts у симптомов), появляется только после
                черновика. Показываем как есть, без новой сущности "связи". */}
            {Array.isArray(fm?.manualRelated) && fm.manualRelated.length > 0 && (
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
                Связанные материалы: {fm.manualRelated.join(", ")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DraftSection({ title, tone, children }: { title: string; tone?: "critical"; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-semibold)", color: tone === "critical" ? "var(--color-brand-red)" : "var(--color-text)", marginBottom: 4 }}>{title}</div>
      <ul style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text)", paddingLeft: 18, margin: 0 }}>{children}</ul>
    </div>
  );
}

