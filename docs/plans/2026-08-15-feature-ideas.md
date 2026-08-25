# Idées de features — brainstorm du 2026-08-15

Généré par 5 idéateurs (UX quotidienne, orchestration, observabilité, intégrations, paris IA-natifs)
sur base d'un inventaire du produit ; 43 idées brutes, dédupliquées et vérifiées contre le code
(chaque ancrage spot-checké par grep). Effort : S = une session, M = quelques jours, L/XL = structurant.

## ⚡ Quick wins (une session chacun) — ✅ livrés (PR #2, mergée)

### Onglet Activity véritable — brancher enfin ticketActivityLog (+ récit du jour en phase 2) `S`
Fusion des trois idées qui lisent la même table morte : une route GET epics/[epicId]/activity, l'entrelacement chronologique transitions/commentaires dans l'onglet Activity existant (acteur user/agent/system, raison, lien vers la session fautive), puis en phase 2 le digest narratif du Dashboard (« 3 epics livrés, l'agent X attend ta réponse depuis 2h ») qui se nourrit de la même route. Répond en 5 secondes à la question quotidienne du dogfooding : « qui a bougé ce ticket, quand, et pourquoi ? » — l'auditabilité des agents est le socle de confiance du produit. Prévoir un regroupement des transitions système consécutives pour les epics très travaillés.

*Ancrage : Vérifié : lib/workflow/log.ts écrit fromStatus/toStatus/actor/reason/sessionId à chaque transition ; schema.ts:485 (ticketActivityLog) ; grep repo entier = zéro lecture, aucune route GET ; EpicDetail.tsx:410-439 rend uniquement CommentThread. Pattern de route identique à epics/[epicId]/comments.*

### Capture éclair de ticket (UI d'abord, CLI ensuite) `S`
Fusion des deux idées de capture : un champ de saisie rapide dans le header kanban qui fait un POST epics direct en backlog — titre = la phrase dictée à chaud, sans aller-retour LLM — sur le modèle exact de BugCreateDialog qui le fait déjà pour les bugs. Les tickets réels du dogfooding sont des phrases brutes avec fautes ; le parcours actuel (conversation epic_creation complète) est surdimensionné pour capturer une pensée d'une ligne. Phase 2 : les commandes « arij ticket "..." » dans le bin existant, simple client HTTP des routes en place. La carte brute doit rester visuellement distinguable pour inciter au raffinage avant dispatch.

*Ancrage : Vérifié : components/kanban/BugCreateDialog.tsx existe (modèle dialog → POST direct) ; bin/arij.mjs confirmé coquille next-only (dev/build/start), structure de commandes prête à étendre ; route POST epics existante.*

### Barre de filtres et mode focus du kanban `S`
Le Board rend toujours 100 % des cartes — 93 epics dans le seul projet Arij, dont une colonne Done massive. Filtres purement client (type, priorité, « agent en cours », « réponse IA non lue », « session échouée ») insérés dans le useMemo epicViews qui calcule déjà toutes ces données, plus un mode focus qui replie Done/Released en compteurs. Zéro changement serveur, zéro changement useKanban. Passer de « scanner 100 cartes » à « voir les 5 tickets qui demandent mon attention ». Compromis DnD : désactiver le drag quand un filtre est actif pour éviter les cartes qui disparaissent au drop.

*Ancrage : Vérifié : Board.tsx:114-132 (unreadAiByEpicId), :180 (epicViews assemble isRunning/unreadAi et alimente déjà les badges d'EpicCard) — le point d'insertion du filtre est exactement là.*

### Webhooks sortants : le téléphone vibre quand le batch est fini `S`
Une URL de webhook par projet (ntfy.sh, Discord, Slack, n'importe quel endpoint) appelée en fire-and-forget sur session:completed/failed et release:created, avec titre du ticket, durée et lien profond vers la session. L'usage réel est des batchs longs pendant que l'utilisateur fait autre chose : aujourd'hui tout meurt dans l'onglet du navigateur. C'est la brique « quitter l'écran » qui rend crédibles le batch build et, demain, le mode nuit. Ne jamais mettre le contenu du ticket dans l'URL ; timeout court pour ne pas bloquer la fin de session.

*Ancrage : Vérifié : lib/events/emit.ts émet déjà session:started/completed/failed et ticket:* avec projectId/epicId ; lib/notifications/create.ts centralise la fin de session ; app/settings/page.tsx existe pour la config.*

### Le relecteur n'est pas l'auteur : ségrégation multi-provider en un toggle `S`
Une règle « Reviewer must differ from builder » dans la config agents : si l'epic a été buildé par claude-code, la résolution du review bascule automatiquement vers un autre provider détecté (codex, gemini-cli...), avec fallback si un seul CLI est installé et affichage du provider résolu dans le dialog de dispatch. Un modèle qui relit son propre code reproduit ses angles morts ; Arij est le seul orchestrateur local multi-CLI capable d'offrir la revue contradictoire inter-modèles en un clic — différenciateur maximal pour un coût minimal.

*Ancrage : Vérifié : lib/agent-config/agent-resolution.ts est le point unique de résolution provider (importé par 15 routes dont build et review) ; app/api/providers/available existe ; agentSessions.provider en base pour connaître le provider du build.*

### Git fetch invisible : des compteurs ahead/behind qui disent la vérité `S`
Ne pas exposer de bouton Fetch (l'utilisateur d'Arij ne pense pas en plomberie git) : appeler fetchGitRemote dans la route git/status quand le dernier fetch date de plus de N minutes (TTL en mémoire par repo), et afficher « à jour il y a X min ». Supprime la classe de bugs silencieux « behind 0 alors que le remote a bougé » qui fait merger des PRs sur une base périmée — exactement le genre d'accident que l'agent de résolution de conflits doit ensuite rattraper. Fetch asynchrone si la latence gêne le refresh.

*Ancrage : Vérifié : lib/git/remote.ts:fetchGitRemote strictement orphelin (grep : un seul fichier) ; route git/status et useGitStatus.ts comme point d'appel et consommateur ; EpicGitSection et git-sync affichent les compteurs.*

## 🔧 Features moyennes — ✅ livrées (branche feat/m-tier, 2026-08-17)

### Verdict de livraison : l'issue de chaque session devient un signal de première classe `M`
(Fusion observabilité + paris-IA.) Promouvoir en champ persisté « outcome » sur agent_sessions ce que le code détecte déjà en booléens jetables : answered / asked_question / silent / error, affiché en badge sur les cartes kanban et la liste Sessions, et surtout branché sur le workflow — asked_question garde le ticket in_progress avec notification actionnable qui resume la session CLI. Les trois derniers bugs réels du dogfooding sont des agents qui livrent « à côté » (question au lieu d'action, markdown au lieu de réponse) : ce verdict transforme la classe de bugs dominante en mécanique produit. L'arbitre LLM court reste une option v2 pour les cas ambigus ; commencer par les verdicts déterministes sûrs, et logguer chaque décision dans ticketActivityLog.

*Ancrage : Vérifié : json-parser.ts:29 (NO_TEXTUAL_OUTPUT_FALLBACK), :83 (hasAskUserQuestion), spawn.ts:172 (endedWithQuestion) et :393-398 (extraction des tool_use AskUserQuestion) ; build/route.ts:511 consomme déjà endedWithQuestion pour bloquer la transition review — la moitié du câblage existe, il jette le signal au lieu de le persister. resolve-session-output.ts comme point unique de résolution.*

### Build par vagues : le mode DAG qui rebranche buildExecutionPlan `M`
(Fusion des trois lentilles — l'idée la plus convergente du brainstorm.) Troisième mode « Dependency order » dans la toolbar batch : couches topologiques calculées par buildExecutionPlan, chaque vague en Promise.all, un échec marque les dépendants « skipped » avec raison (le statut existe déjà dans le type). L'état actuel est un piège actif : la sélection auto-inclut les prérequis transitifs puis le mode parallel lance tout en même temps — l'agent aval construit sur du code qui n'existe pas encore. C'est autant un correctif de cohérence qu'une feature, et les deux tiers du chemin sont déjà écrits. Politique d'échec (skip ou poursuite) exposée en case à cocher ; progression par vague restituée dans l'AgentMonitor.

*Ancrage : Vérifié : lib/dependencies/scheduler.ts:30 (buildExecutionPlan + LayerResult + statut skipped, testés dans __tests__/dag-scheduler.test.ts, appelés par aucune route) ; build/route.ts:547-552 (boucles sequential/parallel existantes, launchEpic isolé et réutilisable) ; hooks/useBatchSelection.ts (fermeture transitive déjà câblée).*

### Inbox cross-projets des agents en attente `M`
(ux-quotidien.) Une vue agrégée accessible depuis la Sidebar : tous projets confondus, les tickets dont le dernier commentaire est un agent non lu, avec réponse inline et bouton Send to Dev. Avec 4 projets, une question d'agent peut pourrir 4 heures dans une colonne qu'on ne regardait pas — c'est la friction n°1 documentée par le dogfooding, et le temps de cycle humain↔agent est le vrai goulot du produit. Chantier propre à inclure : migrer le « vu » de sessionStorage vers la DB pour unifier la source de vérité avec la cloche de notifications (sinon double comptage).

*Ancrage : Vérifié : Board.tsx:45 (isAiCommentAuthor) et :114-132 (unreadAiByEpicId sur latestCommentId/latestCommentAuthor, vu/non-vu en sessionStorage) ; l'API epics sert déjà latestCommentAuthor ; POST comments existant pour la réponse inline.*

### File d'attente réelle et budget de concurrence par projet `M`
(orchestration.) Le statut « queued » existe dans le lifecycle mais est fictif : markSessionRunning suit createQueuedSession d'une milliseconde, et 12 epics sélectionnés = 12 CLIs simultanés sur la machine. Un scheduler singleton en mémoire (même pattern que processManager) avec maxConcurrent par projet : les sessions restent queued en DB et démarrent quand un slot se libère — l'AgentMonitor et la page Sessions les affichent gratuitement puisque le statut existe déjà. Prérequis de tout batch sérieux et du mode nuit ; protège RAM/CPU et rate limits. Ré-adopter les queued orphelines au boot (pattern backfill existant).

*Ancrage : Vérifié : lifecycle.ts:30 (ALLOWED_TRANSITIONS.queued = [running, cancelled, failed]), :239 createQueuedSession et :248 markSessionRunning déjà séparés — la file s'insère exactement entre les deux ; build/route.ts:552 (Promise.all non borné) et :467 (markSessionRunning immédiat) confirment le problème.*

### Watchdog des sessions muettes `M`
(Fusion orchestration + observabilité.) Un superviseur central qui factorise les boucles de poll dupliquées (build/review/merge ont la même boucle while-running-sleep-2s) et compare l'horloge au dernier chunk de chaque session running : silence de N minutes → notification « l'agent semble bloqué » avec lien session, badge orange dans l'AgentMonitor, kill opt-in vers failed. Le bandeau affiche déjà le temps écoulé, il ne dit pas si c'est du travail ou du vide — le dogfooding découvre les agents plantés en revenant par hasard devant l'écran. Seuil par type d'agent pour éviter les faux positifs des gros builds silencieux. Complément naturel du Verdict (lui juge la fin, le watchdog surveille le pendant).

*Ancrage : Vérifié : lib/agent-sessions/chunks.ts (appendSessionChunk avec createdAt par chunk — la matière première horodatée existe) ; boucle de poll confirmée dans build/route.ts:480-483, dupliquée dans review et merge ; lib/activity-registry.ts (sessions vivantes) ; lib/notifications/create.ts.*

### Observatoire coût et fiabilité des agents `M`
(Fusion des trois idées d'analytics observabilité : coût par session + scoreboard fiabilité + métriques de flux.) V1 resserrée : persister input/output tokens et total_cost_usd en fin de session (colonnes nullables, claude-code d'abord), afficher le coût par session et le cumul par epic ; taux de réussite et durée médiane par agent nommé × provider en onglet du panneau Agent Config, avec mini-badge dans les sélecteurs de dispatch ; et le taux d'allers-retours review→in_progress par epic depuis ticketActivityLog. Aujourd'hui le choix d'agent est à l'aveugle et la facture invisible sur 93 epics dispatché — le coût par ticket est la métrique de confiance n°1 pour décider quoi déléguer et à quel modèle.

*Ancrage : Vérifié : json-parser.ts:430 (metadata.usage capté puis jeté — aucune colonne coût dans agentSessions, schema.ts:132-157) ; namedAgentName/provider/model/status/error/timestamps déjà en base ; ticketActivityLog horodate chaque rebond. Les 8 autres providers n'émettent pas tous un bloc usage : colonnes nullables.*

### Mémoire de projet apprise entre sessions `M`
(paris-IA.) Après chaque session terminée, un agent greffier distille les conventions découvertes (« les tests utilisent createTestDb() », « ne jamais drizzle generate ») dans un document mémoire par projet, éditable dans l'onglet Docs, injecté dans tous les prompts via une memorySection à côté de specSection. Chaque session repart aujourd'hui de zéro — et la preuve du besoin est dans le repo même : un MEMORY.md est maintenu à la main côté Claude Code. Gain direct en tokens, en durée et en qualité. Taille plafonnée et relecture humaine pour éviter l'accumulation de faux.

*Ancrage : Vérifié : lib/claude/prompt-sections.ts:73-95 (specSection + documentsSection assemblés par projectContextSections — la memorySection s'ajoute en une fonction) ; markSessionTerminal (lifecycle.ts:259) comme hook de fin de session ; table documents existante ; agentSessionChunks comme matière première.*


> **Écarts assumés du tier M** (revue d'intégration finale) : ~~le mini-badge de fiabilité
> dans les sélecteurs de dispatch n'a pas été construit (stats visibles dans l'onglet Stats
> uniquement)~~ **livré (2026-08-25)** — badge taux de réussite + durée médiane sur 30 jours
> par agent nommé et par type de tâche dans tous les sélecteurs de dispatch, plus la
> sélection informée en Full Auto (`auto_mode_smart_dispatch`) ; les queued orphelines au
> boot sont annulées, pas ré-adoptées (les closures meurent avec le process) ; voir les
> messages de commit pour le détail.

## 🚀 Gros paris — MCP, pipeline autonome et mode nuit livrés (2026-08-17) ; timeline rejouable écartée par décision produit

### Arij serveur MCP : le contrat de sortie des agents devient outillé `L`
(integrations — le pari structurant.) Exposer un serveur MCP local avec update_ticket_status, post_comment, ask_question, submit_findings, injecté dans chaque session spawnée via --mcp-config. Cause racine de la classe de bugs dominante : les agents n'ont aucun canal structuré vers Arij, leur contrat de sortie est une convention de prose espérée dans le prompt. Avec MCP, « l'agent pose une question » devient un appel d'outil vérifiable qui garde le ticket in_progress — le Verdict de livraison (tier M) est le palliatif immédiat, MCP est la solution durable qui le rend presque obsolète. Commencer claude-code + codex ; sécuriser par token de session par agent.

*Ancrage : Vérifié : lib/claude/spawn.ts et lib/providers/base-provider.ts (point d'injection des flags CLI par provider) ; lib/workflow/engine.ts applyTransition réutilisable tel quel par les outils MCP ; routes comments et qa factorisées côté serveur. Le backlog dogfooding (agents qui livrent des markdowns au lieu de réponses) est le cahier des charges.*

### Pipeline autonome build → review → fix (avec retry et légiste intégrés) `L`
(Fusion orchestration + paris-IA : pipeline + retry avec escalade + médecin légiste.) Quand le build atteint markSessionTerminal en succès, enchaîner le review ; si findings bloquants, relancer un agent fix en resume de la session de build ; sur échec, retry borné (resume d'abord, puis escalade de modèle/provider), et un agent légiste qui lit les chunks de la session fautive et poste le diagnostic en commentaire. Le flux réel du dogfooding est exactement ticket→build→review→merge exécuté à la main : l'automatiser supprime la latence humaine entre chaque étape, qui est le vrai goulot. Le précédent architectural existe déjà en production : l'autoAgent de résolution de conflits du merge. Dépend du Verdict pour définir « findings bloquants » proprement ; plafonner les tentatives et tout tracer dans ticketActivityLog.

*Ancrage : Vérifié : merge/route.ts:38-41 et :106-107 (« Merge failed — if autoAgent is enabled, launch a merge-fix agent » — le chaînage conditionnel sur échec est déjà shippé, appelé avec autoAgent: true ligne 248) ; resumeSession/cliSessionId dans providers/types.ts:46-48 ; validate-resume.ts ; build et review partagent le même pattern de callback terminal où se greffe le chaînage.*

### Mode nuit : drainer le backlog pendant le sommeil `L`
(orchestration — le pari étendard.) Un bouton « Night run » : tous les epics To Do, plan DAG, exécution par vagues sous budget de concurrence, en pipeline build→review, circuit-breaker après N échecs consécutifs. Au réveil : 7 en review, 2 échoués, 1 skipped, résumé par la cloche et le webhook. C'est la promesse ultime d'un orchestrateur local-first — la machine travaille quand l'humain dort — et son coût marginal devient faible une fois la file, les vagues, le watchdog et le retry livrés : il ne reste que la boucle de contrôle et le circuit-breaker. À séquencer en dernier, comme couronnement du tier M. Gérer veille machine et reprise propre des sessions interrompues.

*Ancrage : Vérifié : composition de briques toutes confirmées — buildExecutionPlan (scheduler.ts), launchEpic isolé (build/route.ts), notifications de fin de session (lib/notifications/create.ts), SSE session:*/ticket:* (lib/events/emit.ts). Le seul vrai neuf est la boucle de contrôle.*

### Timeline de session rejouable `L`
(observabilité.) Dans la page session, remplacer le dump de logs par une frise chronologique : chaque tool_use, chaque bloc assistant, chaque stderr, avec la durée entre événements et un curseur de replay — on voit ce que l'agent a fait, fichier par fichier, minute par minute. La matière existe en double (NDJSON horodaté + chunks en DB indexés par séquence), il manque uniquement la couche de présentation. C'est l'outil de post-mortem qui répond à « qu'a fait l'agent pendant 12 minutes ? » quand une session livre n'importe quoi, et le socle visuel sur lequel le légiste du pipeline et l'attribution de code pourront s'appuyer plus tard.

*Ancrage : Vérifié : lib/claude/logger.ts (createStreamLog:15, appendStreamEvent:42, ts+seq par événement) ; agentSessionChunks avec createdAt par chunk et index session+séquence (chunks.ts) ; spawn.ts parse déjà les blocs tool_use/assistant.*

## 🌙 Idées folles

### Tournoi d'implémentations : deux agents, un juge
Sur un ticket critique ou ambigu (la moitié du backlog dogfooding), « Build as tournament » : deux worktrees -a/-b, deux providers différents sur le même prompt, puis un agent juge en mode analyze (le mode read-only dort déjà dans ProviderSpawnOptions — vérifié types.ts:36) qui compare les deux diffs et poste un verdict argumenté. L'humain merge la branche gagnante. Payer 2x le compute pour choisir la meilleure implémentation est un arbitrage que seul un orchestrateur multi-provider local peut offrir. Le vrai chantier n'est pas le spawn : c'est le guard « un agent par epic » (lib/agents/concurrency.ts) et le modèle « un branchName par epic » en DB — XL assumé, à prototyper après la ségrégation reviewer/builder qui en est l'entrée de gamme.

### arji.json multiplayer : deux instances Arij synchronisées par git
L'arji.json est déjà commité, exporté après chaque mutation, et la route sync sait importer ET exporter (vérifié sync/route.ts:27). En faire officiellement le médium de collaboration : après un git pull, Arij détecte un arji.json plus récent que lastSyncedAt et propose un import-merge (nouveaux epics/commentaires du collègue) au lieu de l'écrasement destructif actuel. Multiplayer sans serveur, la forge git fait le transport — parfaitement dans l'ADN local-first. Le vrai sujet est le merge par champ (last-write-wins sur les statuts, union sur les commentaires) avec diff-preview avant application.

### Spec vivante : la spec qui se réécrit après chaque release
Inverser le flux : à chaque release, un agent compare la spec au diff livré et propose des patchs accept/reject — sections nouvelles, sections devenues fausses, badge « drift ». Sur un projet piloté par tickets dictés à chaud, la spec diverge en semaines ; or specSection alimente les prompts de tous les agents (vérifié prompt-sections.ts:73-95), donc sa fraîcheur améliore mécaniquement toutes les sessions. Déclencher par release plutôt que par merge pour éviter le bruit — l'agent release_notes tourne déjà au même moment avec le même contexte.

### PM-agent de grooming du backlog
Un type de check QA « backlog_groom » : l'agent lit tout le backlog et rapporte doublons probables (matching sémantique — les tickets sont dictés en français avec fautes), epics à découper, dépendances manquantes, chaque finding avec action applicable en un clic sur le modèle exact du « Create Epics » des rapports QA. 93 epics et personne ne groome. Détail savoureux vérifié : les colonnes epics.confidence et evidence dorment déjà dans le schéma (schema.ts:66-67), inutilisées — visiblement prévues pour exactement ce genre de scoring. Imposer une sortie JSON validée pour ne pas retomber sur le pain point « l'agent a rendu un markdown ».

## 🎯 Top 3 recommandé

1. **Onglet Activity véritable (brancher ticketActivityLog)** — Un orchestrateur AI-first ne vaut que la confiance qu'on accorde à ses agents, et la confiance commence par l'audit : « qui a bougé ce ticket, quand, pourquoi » est LA question quotidienne du dogfooding (agents qui déplacent des tickets en posant une question). Côté code, c'est le creux le plus flagrant et le moins cher de tout l'audit : lib/workflow/log.ts écrit déjà tout (actor, reason, sessionId) à chaque transition, le grep confirme zéro lecture dans le repo, et l'onglet cible existe déjà dans EpicDetail. Une route GET + un entrelacement = livrable en une session, et ça pose le socle du récit du jour, des métriques de flux et du légiste. Le meilleur ratio valeur/effort des 43 idées.

2. **Verdict de livraison (l'outcome de session pilote le workflow)** — La vision d'Arij est de déléguer à des agents sans les surveiller ligne à ligne ; or la classe de bugs dominante du backlog réel est « l'agent a livré à côté » (question au lieu d'action, markdown au lieu de réponse). Le code sait déjà presque tout détecter — hasAskUserQuestion, NO_TEXTUAL_OUTPUT_FALLBACK, endedWithQuestion est même déjà consommé par build/route.ts:511 pour une transition — mais jette ces signaux au lieu de les persister. Les promouvoir en champ outcome qui pilote les transitions transforme la méta-correction au cas par cas en mécanique produit, et trace le chemin vers le vrai pari long terme (le contrat MCP). C'est la feature qui fait passer Arij de « lance des agents » à « comprend ce que les agents ont fait ».

3. **Build par vagues (mode DAG)** — La promesse d'un orchestrateur AI-first local, c'est « ton backlog s'exécute tout seul dans le bon ordre » — et le code est aux deux tiers du chemin : buildExecutionPlan est écrit, testé (__tests__/dag-scheduler.test.ts) et appelé nulle part, launchEpic est déjà une fonction isolée, la sélection transitive est câblée dans useBatchSelection. Surtout, l'état actuel est un piège actif qui contredit le produit : Arij auto-inclut les prérequis d'une sélection puis les lance tous en parallèle, donc l'agent aval build sur du code qui n'existe pas. C'est à la fois un correctif de cohérence, la valorisation d'un investissement déjà payé (le DependencyEditor), et le prérequis direct du pipeline autonome et du mode nuit.

## Idées écartées (et pourquoi)

1) Palette Cmd+K — différée, pas enterrée : forte valeur pour un utilisateur 6h/jour, mais c'est la candidate M la moins agent-native (navigation générique + dépendance cmdk), et le trio Inbox + capture éclair + filtres couvre l'essentiel du besoin de navigation à court terme. À reprendre une fois le tronc agentique livré, en réutilisant les garde-fous d'AgentActionsBar pour les actions. 2) Attribution par ligne dans le DiffViewer — écartée : le blame croisé aux fenêtres temporelles des sessions devient approximatif dès que deux sessions se chevauchent sur la même branche (cas réel et fréquent : build puis resolve-merge auto), et la Timeline de session rejouable offre le même pouvoir d'enquête sans fausse certitude d'attribution. 3) Estimation calibrée sur l'historique — écartée pour l'instant : corpus mono-projet (93 epics d'un seul repo), risque élevé de fausse confiance affichée sur les cartes ; l'Observatoire coût/fiabilité livre d'abord les données brutes, on recalibrera quand plusieurs projets auront de l'historique. Également sortis des tiers sans développement : la fermeture automatique d'issues GitHub (risque d'effet de bord sur dépôt public supérieur à la valeur pour un utilisateur solo-local — à revisiter avec la Sentinelle CI), et trois finitions S valables mais sous la barre des quick wins retenus (undo kanban, CRUD des prompts QA, templates arji.json) qui restent au backlog comme lot de polish.