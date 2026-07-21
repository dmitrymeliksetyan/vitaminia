# medizin-shared

Общая библиотека кода между **medizin** (сайт/SSR) и **medizin-worker**
(автономный AI-воркер производства контента) — появилась на этапе
"Выделение AI Worker в отдельный независимый сервис" по явному требованию:
не дублировать модули, которые реально нужны обеим сторонам, а вынести их в
общий пакет.

## Почему только `.mjs`, без TypeScript

`medizin` — Astro-проект, часть этого кода (`content-registry/validate.mjs`,
`search.mjs`, `seo-health.mjs`) импортируется не только на сервере, но и
**прямо в браузерный бандл** (React-компоненты `LibraryApp.tsx`/
`EditorialApp.tsx`, собираемые Vite). `medizin-worker` — обычный Node-проект
без какой-либо сборки фронтенда. Единственная форма кода, которая одинаково
надёжно резолвится в обоих мирах без отдельного шага компиляции — plain ESM
`.mjs`: Vite пре-бандлит такие файлы как обычную зависимость node_modules,
Node исполняет их напрямую. TypeScript внутри `file:`-зависимости потребовал
бы, чтобы Vite сам транспилировал сырой `.ts` изнутри слинкованного пакета —
это не гарантированно работает и не стоит риска ради нескольких файлов.
Поэтому: **в этом пакете НЕТ и не должно быть `.ts`/`.tsx` файлов.**

## Состав

- `src/content-registry/validate.mjs` — проверки реестра контента (дубли,
  битые ссылки, обязательные поля, titleTag/metaDescription).
- `src/content-registry/search.mjs` — токенизация/Левенштейн/поиск похожих
  материалов (`searchRegistry`) — используется и препаб-проверкой дублей, и
  AI-стратегом, и админкой.
- `src/content-registry/links.mjs` — граф внутренних ссылок (`buildLinkGraph`,
  `collectBrokenLinks`) — зависимость `validate.mjs`.
- `src/content-registry/seo-health.mjs` — «Здоровье контента» (`computeContentHealth`) — зависимость `validate.mjs`.
- `src/content-registry/content-registry-lib.mjs` — Node-нативная сборка
  Content Registry из файлов на диске (`buildRegistry(rootDir)`), в обход
  `astro:content`. **Важно**: `rootDir` теперь ЯВНЫЙ параметр (раньше
  вычислялся автоматически от расположения файла) — potому что medizin и
  medizin-worker читают контент из РАЗНЫХ мест на диске (у medizin это корень
  сайта; у medizin-worker — локальный git-чекаут, который воркер сам себе
  клонирует, см. `medizin-worker/src/github/content-checkout.mjs`).
- `src/normalize-job.mjs` — гарантирует, что поля `content_jobs` (draft/
  research_brief/medical_review/seo_review) всегда приходят в форме,
  безопасной для `.map()` на клиенте — используется и SSR (при чтении job для
  отображения), и Worker (после каждого выполненного этапа).
- `src/strategy-run-lifecycle.mjs` — автоперевод зависших `content_strategy_runs.status='running'` (старше 10 минут) в `'interrupted'`.
- `src/cost-estimate.mjs` — `estimateCostUsd(inputTokens, outputTokens)`: одна и та же приблизительная формула стоимости вызова Anthropic, используемая Worker (при записи `content_job_runs`/`content_strategy_runs`) и SSR (при агрегации уже сохранённых токенов для отображения в `/admin`).

## Что НЕ вошло сюда (и почему)

- **`github-client`** — после этого этапа у SSR больше нет ни одного места,
  которое реально обращается к GitHub API (см. `medizin/DEPLOY.md` и финальный
  отчёт этапа: `source.ts` переведён на чтение локального файла). Единственный
  потребитель — `medizin-worker`, поэтому он живёт там как обычный модуль
  проекта, а не в shared-пакете (общий пакет нужен только когда есть ≥2
  реальных потребителя).
- **`production-config.ts` / его числовые константы** (бюджет, SLA-таргеты,
  heartbeat-интервалы) — сознательно НЕ вынесены сюда. Это осознанное
  исключение: SSR нужна только `BUDGET_EXTENSION_STEP_USD` (кнопка «Продолжить
  ещё»), Worker — весь остальной набор (heartbeat/backoff/concurrency/SLA).
  Публикация набора чисел через общий пакет добавила бы связность между
  проектами ради полудюжины констант, которые в этих двух местах меняются по
  разным причинам (SSR — UI-логика продления бюджета; Worker — тюнинг
  реального процесса производства). У каждого проекта — своя небольшая копия
  только нужных ему чисел, с явным комментарием об этом решении в обоих
  файлах.
- **`job-outcome.ts`** — используется только браузерным компонентом
  `EditorialApp.tsx` (как показать статус администратору), Worker эту логику
  не вызывает вообще — остаётся SSR-only.

## Установка в medizin / medizin-worker

Оба проекта подключают этот пакет как локальную зависимость:

```json
"dependencies": {
  "medizin-shared": "file:../medizin-shared"
}
```

После `npm install` npm создаст symlink в `node_modules/medizin-shared` →
изменения в `medizin-shared/src/**` сразу видны обеим сторонам без
переустановки. Импорт — через `exports`-карту пакета, например:

```js
import { validateRegistry } from "medizin-shared/content-registry/validate.mjs";
import { buildRegistry } from "medizin-shared/content-registry/content-registry-lib.mjs";
```
