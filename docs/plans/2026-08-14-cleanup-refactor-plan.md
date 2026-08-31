# Plan de nettoyage & refacto — 2026-08-14

> **Document d'archive — 2026-08-31.** L'UI décrite ci-dessous a été remplacée par la refonte en control desk à strates d'attention ; ce fichier est conservé tel qu'écrit à sa date et n'a pas été révisé. UI actuelle : `README.md`, `docs/specs.md`.

Audit complet du repo (7 dimensions, chaque affirmation de code mort contre-vérifiée
par grep exhaustif : imports dynamiques, conventions Next.js, fichiers de config, barrels).

**Chiffres clés** : ~196 fichiers d'artefacts trackés à tort (~2,5 Mo), ~2 000 lignes de
code mort confirmé, 7 dépendances npm supprimables, 8 routes API sans aucun appelant,
la suite e2e est garantie rouge, et un fichier de test n'est jamais exécuté par vitest.

Légende : ☐ à faire · chaque item cite fichier:ligne.

---

## Phase 0 — Hygiène git (trivial, une seule PR)

- [x] `git rm -r --cached data/migrations/` — 180 backups/reports JSON de la migration
      `unified-chat-cutover` (~1,3 Mo) générés au runtime par
      `lib/chat/unified-cutover-migration.ts`. **⚠️ Ils contiennent des messages de chat
      utilisateur verbatim** ; ils restent dans l'historique git — si le repo devient
      public, prévoir un `git filter-repo`.
- [x] Ajouter `migrations/` à `data/.gitignore` (il ne couvre que `arij.db*`, `sessions/`,
      `logs/`, `uploads/`).
- [x] `git rm -r --cached .playwright-mcp/` — 13 logs console de debug ; ajouter
      `.playwright-mcp/` au `.gitignore` racine.
- [x] `git rm test-snapshot-*.md` — 3 dumps d'arbre d'accessibilité Playwright à la racine
      (2 sont octet-pour-octet identiques) ; ajouter `test-snapshot-*.md` au `.gitignore`
      à côté de la règle `test*.png` existante.
- [x] `CLAUDE.md:26` : « data/ — gitignored » devient vrai une fois les règles corrigées.
- [ ] **Décision `arji.json`** (744 Ko, réécrit à chaque sync, 29 commits de churn,
      transcripts de conversations complets embarqués) : soit on assume le tracking mais on
      exclut les corps de messages de l'export (`lib/sync/export.ts`), soit `/arji.json`
      passe en gitignore.
- [x] `package.json:22` : la whitelist `files` exclut `lib/`, `components/`, `hooks/`,
      `middleware.ts` → un paquet npm publié serait cassé (et perdrait le middleware de
      sécurité localhost). Ajouter les dossiers manquants ou déclarer `"private": true`.
- [x] Docs : renommer `docs/CLI.md` (c'est un dump de recherche FR sur les CLI LLM tiers,
      pas la doc du binaire `arij`) → `docs/research/headless-llm-clis.md` ; supprimer
      `docs/TECHNICAL_AUDIT_REPORT.md` (obsolète, supplanté par `TECH_AUDIT_2026-02-23.md`) ;
      archiver les 7 plans datés de `docs/plans/` (travail mergé) dans `docs/plans/archive/`.

---

## Phase 1 — Code mort confirmé (suppressions sûres)

### Fichiers entiers — lib/ (~1 100 lignes)

- [x] `lib/claude/prompt-resolver.ts` (148 l.) — supplanté par `lib/agent-config/prompts.ts`, 0 import.
- [x] `lib/types/agent-config.ts` (35 l.) — seul importeur : le fichier ci-dessus.
- [x] `lib/sessions/last-text.ts` (133 l.) + son test — 3ᵉ implémentation parallèle de
      l'extraction de dernier texte.
- [x] `lib/sessions/log-writer.ts` (150 l.) + son test — supplanté par `lib/claude/logger.ts`.
- [x] `lib/utils/markdown.ts` — `markdownToHtml` n'a aucun consommateur ; épingle 5 deps npm.
- [x] `lib/id.ts` + test — doublonne la convention `createId` de `lib/utils/nanoid.ts`.
- [x] `lib/slug.ts` + test — scaffolding test-only.
- [x] `lib/validators.ts` + test — supplanté par les schémas zod de `lib/validation/`.

### Fichiers entiers — components/ & hooks/

- [x] `components/SidebarNav.tsx` — doublon plus ancien de `components/layout/Sidebar.tsx`.
- [x] `components/github/ConnectBanner.tsx` — doublon mort de `GitHubConnectBanner.tsx`.
- [x] `components/kanban/EpicPrControls.tsx` — rôle repris inline dans `EpicDetail.tsx`.
- [x] `components/monitor/LogViewer.tsx` + `__tests__/log-viewer.test.tsx` — test-only.
- [x] `components/shared/ProviderSelect.tsx` — supplanté par `NamedAgentSelect`. Changement
      coordonné : supprimer `provider-select.test.tsx`, les `vi.mock` périmés dans 5 tests,
      et réécrire/supprimer `no-runtime-provider-select.test.ts` (qui épingle l'existence
      du fichier via `fs.existsSync`).
- [x] `components/review/index.ts` — barrel jamais importé.
- [x] `hooks/useCodexAvailable.ts` : supprimer le wrapper `useCodexAvailable` (test-only),
      renommer le fichier `useProvidersAvailable.ts` (l'export survivant).

### Exports morts dans des fichiers vivants — lib/

- [x] `lib/claude/prompt-builder.ts` : `buildSpecPrompt` (l.199), `buildEpicCreationPrompt`
      (l.560), `buildCustomReviewPrompt` (l.1100), `buildCustomEpicReviewPrompt` (l.1157)
      — ~200 l., test-only.
- [x] `lib/git/manager.ts` : `removeWorktree`, `listBranches`, `getCurrentBranch`,
      `listWorktrees`. **⚠️ Garder `epicBranchName`** — le claim initial a été réfuté :
      il est appelé en interne par `createWorktree` (manager.ts:34).
- [x] `lib/git/remote.ts:130` : `pullGitBranchFfOnly` + `FastForwardOnlyPullError` (l.29)
      — paire morte qui ne se référence qu'elle-même.
- [x] `lib/agent-config/providers.ts:142` : `resolveAgentProvider` (test-only).
      **⚠️ `GLOBAL_DEFAULT_AGENT_NAME` est vivant**, ne pas le supprimer.
- [x] `lib/dependencies/scheduler.ts:57` : `executeDagPlan` (~90 l.) — ou le brancher si
      l'exécution auto du DAG est encore prévue (cf. Phase 2).
- [x] `lib/dependencies/crud.ts:88` : `removeDependency` / `removeDependencyEdge` — 0 réf.
- [x] `lib/agents/concurrency.ts:120` : `insertRunningSessionWithGuard` — supplanté par le
      flux queued→running de `lib/agent-sessions/lifecycle.ts`.
- [x] `lib/chat/conversation-agent.ts` : `createCustomReviewConversationAgentType`,
      `parseCustomReviewConversationAgentId`, `isUnselectedConversationAgentType`,
      `isBuiltinConversationAgentType` (~25 l.).
- [x] `lib/github/client.ts:45` : alias `getGitHubToken` ; `lib/events/emit.ts:88` :
      `emitSessionProgress` ; `lib/workflow/engine.ts:154` : `getAllowedTargets`.
- [x] `lib/agent-config/named-agents.ts:7` : re-export `resolveAgent` (seul consommateur :
      un test — le pointer sur `../providers`).
- [x] `lib/chat/parity-contract.ts` : `applyLegacyConversationFilter` est un **no-op
      fonctionnel** (les deux branches retournent `[...conversations]`) appelé depuis
      `UnifiedChatPanel.tsx` et `useConversations.ts` — supprimer fonction + call-sites ;
      supprimer les constantes test-only `LEGACY_CHAT_TAB_TAXONOMY`,
      `LEGACY_CONVERSATION_FILTERS`, `LEGACY_CONVERSATION_SORTS`.
- [x] `lib/codex/spawn.ts:30` : champ `sessionId` de `CodexOptions` — documenté « ignoré »
      et jamais lu.

### Micro-morts — components/

- [x] `EpicActions.tsx:140` et `StoryActions.tsx:145` : variable `lockedTooltip` jamais lue +
      imports `Tooltip/TooltipContent/TooltipTrigger` inutilisés (ou brancher le tooltip
      sur les boutons disabled si c'était l'intention).
- [x] `Board.tsx:176` : `handleDragOver` vide + la prop `onDragOver` du DndContext (l.228).
- [x] Imports inutilisés : `chatMessages` dans `app/api/projects/[projectId]/sessions/route.ts:6`,
      `and` dans `app/api/projects/[projectId]/user-stories/route.ts:4`.

### Routes API sans appelant (8)

Vérifié par grep des URLs (y compris construction par template literals) :

- [x] `GET /api/projects/[projectId]/activity` et `GET .../epics/[epicId]/activity` —
      0 appelant ; l'onglet « Activity » d'EpicDetail rend `CommentThread`, pas ces routes.
      → supprimer **ou** brancher l'onglet dessus (cf. Phase 2).
- [x] `GET .../git/config` — payload consommé nulle part.
- [x] `GET .../git/sync-log` — les tests testent la lib, pas la route.
- [x] `POST .../git/fetch` — test-only, aucun bouton Fetch dans l'UI.
- [x] `POST .../dependencies/plan` — test-only (feature plan d'exécution jamais surfacée).
- [x] `PATCH/DELETE /api/qa/prompts/[promptId]` — aucune UI d'édition/suppression.
- [x] `GET /api/health` — 0 référence (ni playwright webServer, ni bin/, ni CI). Si sonde
      externe voulue : documenter + ajouter l'exemption middleware promise par
      `docs/plans/2026-02-14-security-hardening.md` (absente de `middleware.ts`).

### Dépendances npm (7)

- [x] `@openai/codex-sdk` — 0 import ; Codex passe par le spawn du CLI (`lib/codex/spawn.ts`).
- [x] `unified`, `remark-parse`, `remark-rehype`, `rehype-stringify`, `rehype-sanitize` —
      importés uniquement par `lib/utils/markdown.ts` (mort). Garder `react-markdown` +
      `remark-gfm` (rendu vivant dans `MarkdownContent.tsx`).
- [x] `@types/pdf-parse` (typings v1, pdf-parse v2 embarque les siens) — vérifier avec
      `tsc --noEmit` après retrait.

### Tests morts / doublons

- [x] **`e2e/home.spec.ts` : les 5 tests visent la page boilerplate create-next-app**
      (`toHaveTitle("Create Next App")`) — `npm run test:e2e` est garanti rouge. Réécrire
      un smoke test réel (le plumbing Playwright est correct) ou supprimer.
- [x] **`__tests__/cli.test.mjs` n'est jamais exécuté** : `vitest.config.ts:11`
      `include: ["**/*.test.{ts,tsx}"]` exclut `.mjs`. Renommer en `.ts` ou élargir le glob,
      puis vérifier qu'il passe encore.
- [x] Supprimer `__tests__/publish-release-route.test.ts` (sous-ensemble strict de
      `github-release-publish.test.ts`).
- [x] Supprimer `__tests__/agent-config-named-agents-routes.test.ts` (sous-ensemble de
      `named-agents-routes.test.ts`).
- [x] Supprimer `__tests__/resolve-agent.test.ts` (subsumé par
      `legacy-fallback-named-agents.test.ts` — qui est vivant ; envisager de le renommer
      pour perdre le préfixe « legacy » trompeur).
- [x] Fusionner `git-sync-log.test.ts` dans `github-sync-log.test.ts` (il teste un alias :
      `writeGitSyncLog = logSyncOperation`).

---

## Phase 2 — Décisions produit (mort *ou* pas fini ?)

Chaque item est du code injoignable aujourd'hui, mais qui ressemble à une feature voulue.
Trancher : brancher ou supprimer.

- [x] **`runBackfills()` (`lib/db/index.ts:90`) n'est appelé nulle part** → les 4 modules
      de backfill (`backfill.ts`, `backfill-opencode-json.ts`, `backfill-release-ids.ts`,
      `backfillAgentNames` de `lib/identity.ts`, ~360 l.) sont injoignables. Si les vieilles
      bases doivent être backfillées : l'appeler au démarrage (instrumentation hook).
      Sinon : tout supprimer.
- [x] Onglet Activity : brancher les 2 routes activity ou les supprimer.
- [x] Plan d'exécution DAG : `executeDagPlan` + route `dependencies/plan` — feature
      abandonnée ou à venir ?
- [x] Édition des prompts QA : ajouter l'UI ou supprimer les handlers `[promptId]`.
- [ ] Rétirement de la migration chat : `runUnifiedChatCutoverMigrationOnce` tourne à chaque
      `GET /conversations` (`app/api/projects/[projectId]/conversations/route.ts:42`),
      ~400 l. + la couche « legacy parity ». Plan : marqueur de migration persisté →
      invocation au démarrage → suppression du module et des shims `Legacy*`.

---

## Phase 3 — Plan de refacto (ordonné)

### 3.1 Finir la migration `claudeSessionId` → `cliSessionId` (effort : moyen)

Rename inachevé, étalé sur 10+ fichiers : `@deprecated` dans `lib/providers/types.ts:47` et
`lib/claude/spawn.ts:19`, double-écriture dans `chat/stream/route.ts:217`, fallbacks
`cliSessionId ?? claudeSessionId` dans base-provider, claude-code, gemini-cli, mistral-vibe,
opencode, process-manager, spawn, validate-resume ; colonnes `claude_session_id` encore en
base (`lib/db/schema.ts:103,151`).
→ Migrer les appelants, stopper la double-écriture, supprimer les champs dépréciés,
planifier la suppression des colonnes après backfill.

### 3.2 Unifier le cycle de vie des spawns CLI (effort : gros, gain : ~660 l.)

Le même lifecycle (collecte stdout/stderr, mapping ENOENT, kill SIGTERM→5s→SIGKILL) est
implémenté 4 fois : `base-provider.ts`, `codex/spawn.ts` (348 l.), `gemini/spawn.ts`
(315 l.), `claude/spawn.ts`. `BaseCliProvider` a été écrit pour ça mais son doc-comment
promet un hook `handleExit` **qui n'existe pas** (`base-provider.ts:64`) — c'est le
bloqueur.
→ Ajouter `handleExit`, porter codex (pré-spawn temp file, buildArgs resume, regexes
d'erreur) puis gemini (`extractGeminiResult` colle déjà au contrat `extractResult`),
supprimer les deux spawns. Claude peut suivre. Au passage : factoriser
`buildClaudeArgs(options, outputFormat)` entre `spawnClaude` et `spawnClaudeStream`
(l.68-104 vs 255-290, identiques à un flag près).

### 3.3 Fusionner les deux machines à états de session (effort : moyen)

`lib/sessions/status-machine.ts` (pending/running/…, consommé par process-manager seul) vs
`lib/agent-sessions/lifecycle.ts` (queued/running/…, consommé par toutes les routes) —
lifecycle.ts:91 mappe même `pending`→`queued` pour rattraper la divergence.
→ Fusionner dans `lib/agent-sessions/`, un seul vocabulaire ; après les suppressions de
Phase 1, `lib/sessions/` devient vide → supprimer le dossier. Consolider aussi les
3 implémentations d'« extract last non-empty text » (chunks.ts:52, utils/extract-last-text.ts,
+ la morte) en un module. Renommer `lib/agent-config/providers.ts` →
`agent-resolution.ts` pour désambiguïser de `lib/providers/`.

### 3.4 Couche API : helpers partagés (effort : moyen, très mécanique)

- `getProjectOr404(projectId)` — le lookup projet + 404 est copié dans **34 fichiers de
  routes** ; y intégrer une option `requireGitRepo` (guard répété ~15× avec 3 libellés
  différents).
- `getEpicOr404(projectId, epicId)` / `getStoryOr404` — 11 fichiers dupliquent le lookup,
  et **26 des 32 lookups epic ne filtrent pas par `projectId`** : un epicId d'un autre
  projet se résout sous n'importe quelle URL. Petit enjeu de cloisonnement, pas que du style.
- `errorResponse(error, fallback, status)` — le catch `instanceof Error ? …` est copié
  **43 fois**.
- Normaliser l'enveloppe d'erreur : dialecte `{ error: "not_found", message }` des routes
  git/GitHub vs `{ error: "<message>" }` partout ailleurs (les clients affichent des codes
  bruts). Cas aggravé : le même conflit 409 a **deux shapes différentes dans le même
  fichier** (`epics/[epicId]/review/route.ts:106` vs l.222 — la variante `checkSessionLock`
  n'est pas reconnue par `isAgentAlreadyRunningError` côté client).
- Étendre zod : seules 7 routes sur ~44 qui parsent un body passent par `validateBody` ;
  le helper et le format d'erreur existent déjà (`lib/validation/`).
- Divers : `chat/stream/route.ts` → `NextResponse.json` pour les branches d'erreur JSON ;
  remplacer les 2 lookups PAT inline par `getGitHubTokenFromSettings()` (corrige au passage
  le cas token-vide dans `pr/route.ts:79`) ; normaliser `{ ok: true }` / clés sœurs de
  `data` / mélanges data+error ; statuer 400 vs 422.

### 3.5 UI : dédupliquer les jumeaux (effort : moyen)

- `EpicActions.tsx` / `StoryActions.tsx` : **~95 % identiques** (772 l. cumulées) →
  un `AgentActionsBar` paramétré par cible + un `ReviewTypesPicker` pour les 4 cartes de
  checkbox copiées-collées.
- `useEpicAgent` / `useTicketAgent` → `useAgentDispatch(projectId, target)` ;
  `useComments` / `useEpicComments` → `useTicketComments` ; `useNamedAgentsList` →
  réutiliser `useNamedAgents`.
- `usePolling(callback, ms, enabled)` — l'idiome setInterval+ref+cleanup est recopié dans
  **9 hooks et 4 composants**.
- `AgentDispatchDialog` partagé — le dialog NamedAgentSelect+SessionPicker+spinner est
  copié **7 fois**.
- `lib/utils/format-date.ts` (`formatTime`, `formatDateTime`, `timeAgo`) — 5 copies
  locales ; `TicketTypeBadge`/`PriorityBadge` partagés (le markup bug-badge est dupliqué
  EpicCard:258 / EpicDetail:287 — zone touchée par les 2 derniers commits badges).

### 3.6 Découper les 2 composants géants (effort : gros)

- `UnifiedChatPanel.tsx` (870 l.) → `usePanelLayout` (ratio/drag/localStorage),
  `ChatTabBar`, `ChatWorkspaceHeader`, `useSpecGeneration` ; ne poller les conversations
  que si le panel est visible.
- `EpicDetail.tsx` (776 l., 6 hooks data + 3 fetch inline) → `EpicGitSection`,
  `EpicUserStoriesSection`, `EpicDangerZone`, `ResolveMergeDialog` + hooks
  `useEpicMutations`/`useProjectEpicsList`.
- Kanban : 9 props par-epic forwardées telles quelles page→Board→Column→EpicCard →
  view-model `epicView` unique ou `BoardContext` (3 interfaces changent à chaque badge
  ajouté).

### 3.7 Base de données (effort : moyen)

- `lib/db/index.ts:20-85` exécute DDL ad hoc + seed (`claude-opus-4-6` hardcodé) **à
  l'import** → déplacer vers de vraies migrations drizzle + fonction d'init explicite.
- 3 tables drizzle (`agentSessionChunks`, `agentSessionSequences`, `notificationReadCursor`)
  définies mais contournées en SQL brut (chunks.ts:78-127, notifications/route.ts:20) →
  migrer vers l'ORM ou documenter l'exception.
- `lib/db/test-utils.ts` : 350 l. de DDL maintenues à la main en parallèle de schema.ts →
  générer le schéma de test depuis drizzle.

### 3.8 Suite de tests (effort : moyen, continu)

- 64 fichiers hand-rollent la même chaîne de mock drizzle (34 blocs identiques
  `select: vi.fn().mockReturnThis()`) et **58 fichiers réécrivent des fausses colonnes de
  schéma à la main** — un rename de colonne passe les tests et casse la prod. Extraire un
  helper partagé + pousser `createTestDb` (réel, in-memory, utilisé par 6 fichiers seulement).
- Consolider les 11 fichiers d'assertions de colonnes de schéma en un spec table-driven.
- Trancher la convention de localisation : 164 fichiers racine vs 17 colocalisés, avec
  doublons entre les deux (garder la variante real-DB de named-agents).
- Déplacer `app/__tests__/page.test.tsx` vers `__tests__/`.

---

## Bugs relevés au passage (hors périmètre nettoyage)

1. `e2e` garanti rouge (voir Phase 1 / tests).
2. Lookups epic/story non scopés au projectId de l'URL (voir 3.4).
3. Double shape du 409 review non reconnue par le client (voir 3.4).
4. `pr/route.ts:79` : un PAT vide passe le guard `if (!pat)`.
5. `epics/route.ts:209-227` : l'epic est inséré **avant** la validation des dépendances →
   422 renvoyé alors que l'epic est créé.
6. `applyLegacyConversationFilter` no-op livré en prod (voir Phase 1).
7. Seed hardcodé `claude-opus-4-6` dans `lib/db/index.ts:73-85`.

## Ordre suggéré

1. **Phase 0** (1 PR triviale, gros gain d'hygiène immédiat).
2. **Phase 1** (1-2 PRs : suppressions vérifiées, `npm test` + `tsc --noEmit` entre chaque).
3. **Phase 2** (décisions rapides, puis exécution dans la foulée).
4. **Phase 3** dans l'ordre 3.1 → 3.4 → 3.5 → 3.3 → 3.2 → 3.7 → 3.6 → 3.8 (les helpers API
   et les fusions UI débloquent le plus de churn quotidien ; les découpes de composants
   géants peuvent attendre un moment calme).

---

## État final — exécuté le 2026-08-14

Toutes les phases exécutées en 9 commits (`20ba2c6`…`41f06f7`), ~31 400 lignes
supprimées / ~9 700 ajoutées sur 538 fichiers. Suite de tests : 15 fichiers /
28 tests en échec au départ → **157/157 fichiers, 1425/1425 tests verts, zéro
unhandled error**. Erreurs tsc en code de production : 0.

### Follow-ups restants (volontairement différés)

1. **Décision `arji.json`** (case non cochée ci-dessus) : choix produit entre
   exclure les corps de messages de l'export ou gitignorer le fichier.
2. **Rétirement de la migration chat-cutover** : nécessite un marqueur de
   migration persisté avant de retirer `runUnifiedChatCutoverMigrationOnce`
   du GET /conversations et de supprimer le module (~400 l.).
3. **Colonnes `claude_session_id`** : le code n'écrit plus que `cli_session_id`
   (fallback de lecture unique dans `lib/db/resolve-cli-session-id.ts`) ;
   reste à backfiller puis dropper les colonnes + le helper.
4. **Snapshots drizzle-kit périmés** : `meta/*_snapshot.json` s'arrête à 0013
   alors que le journal va à 0022 — `npx drizzle-kit generate` mal-diffferait ;
   continuer à écrire les migrations à la main ou régénérer les snapshots.
5. **Historique git** : les backups de migration (contenu de chat utilisateur)
   restent dans l'historique ; `git filter-repo` requis si le repo devient public.
6. **~25 erreurs tsc dans les tests** (casts de signatures de providers,
   fixtures partielles) — bruit préexistant, sans impact runtime.
