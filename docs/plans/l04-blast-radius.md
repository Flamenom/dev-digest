# Development Plan: L04 — Blast Radius (карта потенційного впливу змін PR)

> Status: **approved** · Scope: server `blast/` module + Overview card + MCP tool · Branch: `feat/L04-mcp`

## Agreed decisions (узгоджено з користувачем)

| Decision | Choice |
|---|---|
| UI-розміщення | **Картка в Overview** поруч з IntentCard (двоколонковий layout, як на дизайні). Окремої вкладки нема |
| LLM-підсумок | **Ні** — фіча повністю детермінована, нуль викликів моделі. Контракт залишає `summary: string \| null` (nullish) для майбутнього кроку |
| Скоуп UI | **Все з дизайну**: лічильники (symbols / callers / endpoints / cron) · перемикач **Tree / Graph** · розгортні символи → callers → чіпи endpoints/cron · блок **Prior PRs touching these files** |
| Клік file:line | **In-app**: перехід у вкладку Files changed зі скролом до файла/рядка; **фолбек на GitHub blob** (head SHA, нова вкладка), якщо файла нема в diff |
| Дані | Тільки repo-intel індекс (Postgres) + локальні `pull_requests`/`pr_files`. **Жодного ripgrep/AST-фолбеку на запиті** |
| Персистенція | Нема — обчислення на читання (патерн smart-diff), кеш на клієнті через TanStack Query |

## Context (investigated ground truth)

- **`repoIntel.getBlastRadius(repoId, changedFiles)` вже реалізований** — `server/src/modules/repo-intel/service.ts:220`. Persistent-шлях (`tryPersistentBlast`, :315) читає `symbols` / resolved `references` / `file_rank` / `file_facts` з Postgres (нуль парсингу на запиті), виключає файл оголошення (`references.fromPath !== decl`), сортує callers за rank desc, повертає `BlastResult{changedSymbols, callers, impactedEndpoints, factsByFile, degraded}` (`repo-intel/types.ts:74`).
- **Знайдений дефект фасаду**: `callers.slice(0, MAX_CALLERS_PER_SYMBOL)` (:386) ріже **глобально**, хоча докстрінг константи каже "cap per changed symbol" (`repo-intel/constants.ts` → `MAX_CALLERS_PER_SYMBOL = 20`). Виправляємо в межах цієї фічі.
- **Фолбек-шлях фасаду** (index відсутній/flag off) парсить clone через `container.codeIndex` — порушує критерій «сервер не перебудовує AST під час запиту». Blast-сервіс **гейтить по `getIndexState`** і фолбек не викликає.
- **Реверсний граф імпортів вже персиститься**: таблиця `file_edges (repo_id, from_file, to_file)` з індексом по `(repo_id, to_file)` (`db/schema/repo-intel.ts:55`) — рівно те, що треба для BFS «хто залежить від зміненого файла». `BFS_DEPTH = 2` вже в constants.
- **Ендпоінти/крони прекомп'ютяться індексером** у `file_facts (endpoints jsonb, crons jsonb)` (:75); читання — `repository.getFileFacts` (:534).
- **Змінені файли PR** вже в БД: `pr_files` (`db/schema/pulls.ts:36`); smart-diff читає їх через `reviewRepo.getPrFiles(prId)` (`smart-diff/service.ts:59`) — той самий шлях для blast.
- **Shared-контракт `BlastRadius` вже існує** в `vendor/shared/contracts/brief.ts:39` (`changed_symbols`, `downstream[{symbol, callers, endpoints_affected, crons_affected}]`, `summary`) — але це формат композитного PR Brief з обовʼязковим `summary`. API-відповідь blast описуємо **новим файлом** `contracts/blast.ts` (EXTEND-only), реюзаючи `ChangedSymbol`; brief.ts не редагуємо.
- **Модуль-шаблон**: `intent/routes.ts` (GET/POST /pulls/:id/*, `getContext` → workspaceId, `IdParams`, `NotFoundError`); binding у `platform/container.ts` (ліниві getters `intent`, `smartDiffService`); реєстрація в `modules/index.ts`.
- **Клієнтська навігація**: сторінка PR тримає `tab`/`finding` у query params (`page.tsx:57-64`, `useQueryParam`); `goToFinding = setParams({tab:"findings", finding:id})` — дзеркалимо для `{tab:"diff", file, line}`. Вкладка diff = `tab === "diff"` (:164). GitHub-лінки — `client/src/lib/github-urls.ts` `githubBlobUrl(fullName, sha, file, line)`.
- **MCP**: `mcp/src/tools/get-blast-radius.ts` — чесний stub, спроєктований під заміну «only this file's description/outputSchema/handler change — the flat args stay». Резолюція repo+pr → uuid: `mcp/src/resolve.ts`. `BlastRadiusOutput` у `mappers.ts:299`.
- **Prior PRs**: `pull_requests` має `number, title, author, status, updatedAt` (без merged_at); перетин по `pr_files.path` з поточним PR у тому ж repo — чисто локальний SQL, без GitHub.

## Tasks

### T1 — Shared contract `contracts/blast.ts` (обидві vendored-копії, lockstep)

Новий файл у `server/src/vendor/shared/contracts/blast.ts` **і** `client/src/vendor/shared/contracts/blast.ts` + export-рядок у обох `index.ts` (додавання, не зміна існуючих шейпів):

```ts
BlastStatus  = z.enum(['ok', 'partial', 'degraded', 'empty'])
BlastCallerRef    = { file, line: int, symbol /* enclosing caller */, rank: number }
BlastSymbolImpact = { symbol: ChangedSymbol /* reuse from brief.ts */,
                      callers: BlastCallerRef[],        // ≤20, rank desc
                      endpoints_affected: string[],      // "METHOD /path" з file_facts caller-файлів
                      crons_affected: string[] }
BlastEndpointRef  = { endpoint: string, file: string, depth: int /* 1|2 */ }
BlastPriorPr      = { number: int, title, author, status, files_overlap: string[] }
BlastResponse = {
  status: BlastStatus,
  reason: string nullish,                    // пояснення для partial/degraded/empty
  counts: { symbols, callers, endpoints, crons: int },
  symbols: BlastSymbolImpact[],
  endpoints: BlastEndpointRef[],             // union: рівень 1 (caller-файли) + рівень 2 (reverse imports)
  prior_prs: BlastPriorPr[],
  summary: string nullish                    // зарезервовано під майбутній LLM-крок; зараз завжди null
}
```

Skills: `zod`. Gotcha: `.nullish()` (не `.nullable()`) для опційних полів — root INSIGHTS.md.

### T2 — repo-intel facade: 2 точкові зміни

1. **Per-symbol cap**: у `tryPersistentBlast` замінити глобальний `callers.slice(0, MAX_CALLERS_PER_SYMBOL)` на групування по `viaSymbol` з cap 20 на символ (rank desc усередині групи). Узгоджує код із докстрінгом константи; інших споживачів `getBlastRadius` нема (run-executor використовує `getCallerSignatures`).
2. **Новий метод фасаду** `getReverseDependents(repoId, files, maxDepth = BFS_DEPTH)` → `Array<{file, depth, endpoints, crons}>`:
   - repository: BFS по `file_edges` у зворотному напрямку (`to_file IN (frontier)` → `from_file`), 1 запит на рівень (індекс `file_edges_repo_to_idx` вже є), дедуп відвіданих, виключити самі changed-файли;
   - join `getFileFacts` по знайдених файлах; повертати лише файли, що мають endpoints/crons, + depth.
   - Додати сигнатуру в `RepoIntel` interface (`types.ts`) — контракт server-локальний, розширювати можна. Гейт `repoIntelEnabled=false` / порожній вхід → `[]` (конвенція array-методів фасаду).

Skills: `onion-architecture`, `drizzle-orm-patterns`. Фасад — єдина точка входу; blast-модуль до repo-intel repository напряму не ходить.

### T3 — Server module `blast/` + route `GET /pulls/:id/blast`

`server/src/modules/blast/{routes.ts, service.ts, repository.ts, index.ts}`:

- **routes.ts**: `GET /pulls/:id/blast` (схема `IdParams`, `getContext` → workspaceId) → `container.blastService.get(workspaceId, prId)`. Пул не знайдено → `NotFoundError`.
- **service.ts** (`BlastService`, deps: `repoIntel`, blast-repository, pr-files reader):
  1. pull за uuid (+workspace перевірка) → `repoId`, `headSha`; changed files з `pr_files`.
  2. `repoIntel.getIndexState(repoId)`: `full` → `status:'ok'`; `partial` → `'partial'` + reason («індекс покриває N файлів, частину пропущено»); інші статуси / flag off → `'degraded'` + reason, **дані не обчислюємо і фолбек не викликаємо** (порожні масиви + пояснення — це задекларований стан, не маскування).
  3. `getBlastRadius(repoId, changedFiles)`; якщо результат прийшов `degraded:true` (гонка стану) — теж `'degraded'`.
  4. `changedSymbols.length === 0` → `status:'empty'` + reason («у змінених файлах не оголошено символів» / «PR не має підтримуваних файлів»).
  5. Групування: callers по `viaSymbol` (cap 20/символ вже з фасаду); `endpoints_affected`/`crons_affected` символа = union `factsByFile[callerFile]` по його caller-файлах.
  6. `getReverseDependents(repoId, changedFiles, 2)` → `endpoints[]` з depth; union з рівнем 1.
  7. `counts` — по агрегованих даних.
- **repository.ts**: prior PRs — `SELECT pr.number, pr.title, pr.author, pr.status, array_agg(f.path)` з `pull_requests` join `pr_files` where `path IN changedFiles AND pr.repo_id = :repoId AND pr.id != :prId`, сортувати за `updatedAt desc`, cap 5.
- **container.ts**: лінивий getter `blastService` (+ `ContainerOverrides` для тестів); **modules/index.ts**: import + entry `blast`.

Skills: `fastify-best-practices`, `onion-architecture`, `drizzle-orm-patterns`, `zod`.

### T4 — Client: `BlastCard` в OverviewTab

- **OverviewTab**: двоколонковий grid `IntentCard | BlastCard` (обидві картки рівної висоти, колапс в одну колонку на вузькому вʼюпорті); прокинути нові пропси `repoFullName`, `onGoToFile` зі сторінки.
- **hooks/blast.ts**: `usePrBlast(prId)` — `["pr-blast", prId]`, `GET /pulls/:id/blast`, тип `BlastResponse` з `@devdigest/shared`.
- **`_components/BlastCard/`** (конвенція folder-per-component: `BlastCard.tsx, index.ts, styles.ts, helpers.ts, _components/`, inline styles + CSS-токени, НЕ Tailwind):
  - хедер-лічильники: symbols / callers / endpoints / cron + сегментований перемикач **Tree | Graph** (патерн `DiffTab` segmented);
  - **Tree**: розгортний рядок на символ (`<> name()` + "N callers") → список callers `file:line` → чіпи `GET /path` (endpoint) і cron; перший символ розгорнутий;
  - **Graph**: власний layered SVG без зовнішніх бібліотек — три колонки вузлів (changed symbols → caller files → endpoints/crons), ребра-полілінії, ті самі клік-обробники; дані ті ж, окремого payload не треба;
  - **Prior PRs touching these files**: колапс-футер зі списком `#number title · author · status · overlap`;
  - стани: skeleton (loading) · `empty` («No symbols declared in changed files») · банер `partial` · банер `degraded` з reason і підказкою («index the repo / увімкнути repo-intel»); 4xx — тихий inline empty state (конвенція клієнта).
- **Клік file:line**: `onGoToFile(file, line)` зі сторінки = `setParams({ tab: "diff", file, line })` (дзеркало `goToFinding`); файл поза diff → `window.open(githubBlobUrl(repoFullName, headSha, file, line))`. Приналежність до diff перевіряємо по `files` (`PrFile[]`), які сторінка вже тримає.
- **DiffTab**: новий проп `fileTarget?: {file, line}` — після рендера скролить відповідний `FileCard` у вʼюпорт (`scrollIntoView`) і підсвічує рядок, якщо він є у patch; працює в обох режимах (smart/original); одноразово, потім параметр чиститься.
- **i18n**: новий namespace `messages/en/blast.json`.

Skills: `next-best-practices` (memory: завжди), `react-best-practices`, `frontend-ui-architecture`.

### T5 — MCP: реальний `devdigest_get_blast_radius`

- `mcp/src/tools/get-blast-radius.ts`: залишити flat args `{repo, pr}` → `resolveRepo` + `resolvePr` → `GET /pulls/:id/blast` → мапер у стислий structured output:
  `{ status, reason?, counts, symbols: [{name, file, kind, callers: ["file:line (caller)"...] /* cap ~10 для токенів */, endpoints, crons}], endpoints: ["METHOD /path"...], prior_prs: [...] }`.
- `mappers.ts`: переписати `BlastRadiusOutput` під нову форму; оновити title/description («Call this when…», без "not implemented"); анотації `readOnlyHint: true, openWorldHint: false` лишаються.
- Errors — через існуючий `toToolError` (degraded/partial — НЕ помилка, а нормальний результат зі status).

### T6 — Тести

- **server hermetic** (`server/test/blast.test.ts`): `BlastService` з mock `repoIntel` через `ContainerOverrides` — шляхи ok/partial/degraded/empty, групування per-symbol, атрибуція endpoints по factsByFile, union depth-1/2, counts.
- **server it** (`blast.it.test.ts`, testcontainers): route end-to-end + prior-PRs SQL. Gotcha: унікальний `fullName` репозиторію (seed вже створює `acme/payments-api` — server/INSIGHTS.md).
- **repo-intel**: тест per-symbol cap (>20 callers на символ) + `getReverseDependents` (it-тест: ланцюжок a→b→c у file_edges, глибина 2, дедуп, виключення changed-файлів).
- **client**: `BlastCard.test.tsx` (RTL: стани, розгортання, клік file:line → onGoToFile / GitHub-фолбек), оновити `OverviewTab`-тести під grid і нові пропси.
- **mcp**: тест мапера/тула за існуючим патерном пакета (звірити на місці).

Skills: `react-testing-library`.

### T7 — Верифікація і демо

1. `pnpm typecheck` + `pnpm test` у `server/`, `client/`, `mcp/`; `pnpm arch` у server/ (**під Node 22 через nvm** — server/INSIGHTS.md).
2. Демо: `./scripts/dev.sh` → переконатися, що repo-intel індекс побудований (`repoIntelEnabled`, стан `full`); demo-PR зі зміною спільної допоміжної функції → картка показує **≥2 callers і ≥1 endpoint**.
3. Клік file:line: файл у diff → скрол у Files changed; поза diff → GitHub blob на head SHA з якорем рядка.
4. MCP: `cd mcp && pnpm inspect` → `devdigest_get_blast_radius {repo, pr}` повертає структуровану відповідь.

## Мапа критеріїв приймання

| Критерій | Де закривається |
|---|---|
| ≥2 callers + ≥1 endpoint на demo-PR | T2/T3 (persistent-дані) + T7.2 |
| Клік file:line відкриває правильне місце | T4 (in-app + GitHub-фолбек) + T7.3 |
| Без перебудови AST/графа на запиті | T3 гейт по `getIndexState`; фолбек фасаду не викликається |
| Зрозумілий empty state | `status:'empty'` + reason (T3.4, T4) |
| Окремий стан partial/degraded | `status:'partial'/'degraded'` + reason, банери в UI (T3.2, T4) |
| Нуль LLM-викликів | Узгоджено: LLM-підсумку нема взагалі; `summary` завжди `null` |
| `get_blast_radius` через MCP | T5, той самий серверний маршрут |

## Ризики / нотатки

- **Vendored lockstep**: `contracts/blast.ts` додається в ОБИДВІ копії (server + client) синхронно; дві zod-інстанції — ZodError матчиться по shape (root CLAUDE.md gotcha).
- Зміна cap у `tryPersistentBlast` збільшує обсяг callers (20/символ замість 20 всього) — єдиний споживач сьогодні НЕ існує (blast — перший), регресій нема.
- Демо-критерій залежить від наявності індексу `full/partial` для seeded-репозиторію — перевірити на T7, за потреби додати крок індексації в демо-сценарій (не в seed).
- Порядок реалізації: T1 → T2 → T3 → (T4 ∥ T5) → T6 → T7.
