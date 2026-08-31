# Arij — Product Requirements Document

**Version:** 1.2
**Date:** 11 février 2026 — sections UI révisées le 31 août 2026 (refonte « Piscine »)
**Auteur:** Gaétan (Tech Lead AI — Lefebvre Dalloz)
**Statut:** Draft
**Licence:** MIT

---

## 1. Vision

Arij est un orchestrateur de projets AI-first, local, open source. Il fournit une interface web de gestion de projets multi-projet, centrée sur les épics et user stories, avec Claude Code comme moteur d'exécution intégré. L'utilisateur brainstorme, spécifie, planifie et construit ses projets depuis une seule interface, en déléguant l'exécution du code à Claude Code.

**Pitch en une phrase :** Un poste de pilotage multiprojet qui transforme vos idées en specs structurées, lance des agents pour les implémenter, et ne montre à l'utilisateur que ce qui attend une décision de sa part.

---

## 2. Problème

Les développeurs utilisant Claude Code font face à un workflow fragmenté :

- Les idées et specs vivent dans des docs séparés (Notion, Google Docs, fichiers markdown)
- Le suivi des épics et US est géré dans un outil tiers (Jira, Linear, GitHub Issues) déconnecté de l'exécution
- Le lancement de Claude Code est manuel, ticket par ticket, en ligne de commande
- Il n'y a aucune vue unifiée de l'avancement de plusieurs projets en parallèle
- Le contexte projet (docs, specs, historique) doit être réinjecté manuellement à chaque session Claude Code

Les outils existants (CCPM, CloudCLI, Claudia) adressent des morceaux du problème mais aucun ne propose le pipeline complet idéation → spec → planification → build → monitoring dans une seule interface.

---

## 3. Solution

Arij est une web app locale (localhost) qui orchestre le cycle de vie complet d'un projet logiciel :

```
💡 Idéation          📋 Spécification        🔨 Construction        ✅ Livraison
───────────────────────────────────────────────────────────────────────────────
Chat brainstorm  →  Generate Spec & Plan  →  Lancer Claude Code  →  Review & merge
avec Claude         (épics + US auto)        par épic                releases
(mode plan)         Édition manuelle         Monitoring live         Changelogs
```

---

## 4. Utilisateurs cibles

- **Développeurs solo** qui utilisent Claude Code quotidiennement et veulent structurer leur workflow
- **Tech leads** qui gèrent plusieurs projets AI-assisted en parallèle
- **Contributeurs open source** qui veulent un outil léger de PM intégré avec Claude Code

**Prérequis utilisateur :** Claude Code installé et authentifié (souscription Pro ou Max).

---

## 5. Principes de design

1. **Local-first** — Tout tourne en localhost. Pas de cloud, pas de compte, pas de télémétrie. Les données restent sur la machine de l'utilisateur.
2. **Claude Code natif** — L'app n'utilise pas l'API Anthropic directement. Tout passe par le CLI `claude` pour exploiter la souscription de l'utilisateur.
3. **Convention over configuration** — Des choix par défaut sensés, un setup minimal. `npx arij` et c'est parti.
4. **Spec-driven** — Chaque ligne de code produite est traçable jusqu'à une spec. L'épic est l'unité de travail de Claude Code.
5. **Progressive disclosure** — L'écran d'accueil ne montre que ce qui demande quelque chose à l'utilisateur ; la profondeur (registre exhaustif des tickets, logs, git, settings) est à un clic. Voir §11.
6. **L'écran s'organise par urgence, pas par état de workflow** — Ce sont les agents qui font les transitions de statut. L'utilisateur n'a donc pas besoin d'une vue « où en est chaque ticket » en permanence : il a besoin de savoir ce qui tourne, ce qui l'attend, et ce qui peut atterrir. C'est le principe qui a remplacé le board kanban par le poste de pilotage (§11.2). Les statuts n'ont pas disparu pour autant — ils restent le modèle de données (§7.3, §11.5).

---

## 6. Stack technique

| Couche | Technologie | Justification |
|--------|-------------|---------------|
| **Framework** | Next.js 16 (App Router, Turbopack) | Fullstack, React 19.2, Cache Components, proxy.ts |
| **UI** | Tailwind CSS v4 + shadcn/ui | Composants accessibles, ecosystem riche |
| **Design system** | « Piscine » — tokens dans `app/globals.css` (`:root` = palette jour, `.dark` = palette nuit), primitives partagées dans `components/piscine/` | Une seule définition des cinq strates, des tons projet et des surfaces. Nuit par défaut (`ThemeProvider`, `defaultTheme="dark"`) |
| **Typographie** | Bricolage Grotesque (titres) / Instrument Sans (texte) / Space Mono (ids, chronos, logs) via `next/font/google` | Auto-hébergées au build, aucune requête runtime. Geist a été retiré |
| **Base de données** | SQLite (via better-sqlite3 ou Drizzle + libsql) | Local-first, zero config, portable |
| **ORM** | Drizzle ORM | Type-safe, léger, support SQLite natif |
| **Temps réel** | Polling API + SSE léger (statut only) | JSON output = pas de stream, polling pour les mises à jour de statut |
| **Claude Code** | CLI `claude` (spawn child process) | Utilise la souscription, mode plan + mode code, output JSON |
| **Git** | simple-git (Node.js) | Gestion des worktrees, branches, commits |
| **Conversion docs** | mammoth (docx→md), pdf-parse (pdf→text) | Léger, sans dépendance lourde |
| **Markdown** | unified / remark / rehype | Parsing et rendu markdown |
| **Tests** | Vitest + Playwright | Unit + E2E |
| **Package** | npm (publié comme CLI) | `npx arij` pour lancer |

**Drag & drop :** retiré de toutes les surfaces produit (voir §11). `@dnd-kit/*` figure encore dans les dépendances de `package.json`, mais plus aucun écran ne l'importe : la seule mention restante est un commentaire de `components/spec/DocsCard.tsx` précisant que sa zone de dépôt est une cible fichier HTML5 et non un sortable dnd-kit.

---

## 7. Architecture

### 7.1 Vue d'ensemble

```
┌─────────────────────────────────────────────────────────┐
│                    Navigateur                            │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ TopBar globale (montée une fois par app/layout)   │  │
│  │ logo · chips projet · Work/Agents/Réglages · ⌘K   │  │
│  │ · inbox · Auto · New                              │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌─────────────────────────┐ ┌───────────────────────┐  │
│  │ "/" poste de pilotage   │ │  Overlay ticket        │  │
│  │ 5 strates d'attention   │ │  (modal par-dessus)    │  │
│  └─────────────────────────┘ └───────────────────────┘  │
│  ┌──────────────┐ ┌──────────┐ ┌──────┐ ┌────────────┐  │
│  │ /tickets     │ │ /agents  │ │ /qa  │ │ /chat      │  │
│  │ (registre)   │ │ (atelier)│ │      │ │ /usage     │  │
│  └──────────────┘ └──────────┘ └──────┘ └────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ /projects/:id  ·  spec & memory · releases        │  │
│  │                ·  sessions · documents            │  │
│  └───────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP
┌────────────────────────▼────────────────────────────────┐
│              Next.js 16 Backend (API Routes)            │
│                                                         │
│  ┌────────────┐ ┌───────────────┐ ┌──────────────────┐  │
│  │ Projects   │ │ Claude Code   │ │ Spec Generator   │  │
│  │ CRUD       │ │ Process Mgr   │ │ (CC plan mode)   │  │
│  └─────┬──────┘ └───────┬───────┘ └──────────────────┘  │
│        │                │                                │
│  ┌─────▼──────┐ ┌───────▼───────┐ ┌──────────────────┐  │
│  │  SQLite    │ │ Git Manager   │ │ File Converter   │  │
│  │  (Drizzle) │ │ (worktrees)   │ │ (docx/pdf → md)  │  │
│  └────────────┘ └───────────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 7.2 Intégration Claude Code

L'app communique avec Claude Code **exclusivement via le CLI `claude`** (pas l'Agent SDK), ce qui permet d'utiliser la souscription Pro/Max de l'utilisateur.

**Les modes d'utilisation :**

Le mode interne (`ClaudeOptions.mode`) est traduit en `--permission-mode` par
`resolveClaudePermissionMode` (`lib/providers/options-registry.ts`) — il n'existe pas de
flag `--mode` :

| Mode interne | Usage dans Arij | `--permission-mode` émis |
|------|---------------------|--------------|
| **plan** | Génération de specs, analyses en lecture seule | `plan` |
| **chat** | Chat contextuel (repo strictement en lecture, écritures board via MCP) | `default` |
| **analyze** | Import / relecture de codebase (Read, Glob, Grep, Write) | `bypassPermissions` |
| **code** | Implémentation des épics | `bypassPermissions`, sauf override d'un agent nommé |

**Mécanique de lancement :**

1. L'utilisateur sélectionne un ou plusieurs tickets (⌘/Ctrl-clic sur le poste de pilotage, ou depuis l'overlay ticket) — ou Full Auto les sélectionne pour lui
2. Le backend compose un prompt structuré contenant : la spec du projet, les docs uploadés (en markdown), les specs des épics sélectionnées avec leurs US et critères d'acceptation, le CLAUDE.md du repo
3. Pour chaque épic, le backend :
   - Crée un git worktree + branche dédiée (`feature/epic-{id}-{slug}`)
   - Spawne un process `claude` avec le prompt et le cwd pointant sur le worktree
   - Streame la sortie JSON via SSE vers le frontend
4. Le frontend affiche l'avancement en temps réel

**Gestion de la communication :**

```
claude --permission-mode bypassPermissions \
  --output-format json \
  --print -p "Implement epic: ..." \
  --allowedTools Edit Write Bash Read Glob Grep
```

(le worktree est le `cwd` du process enfant, pas un flag ; au-delà de la limite argv le prompt
part sur stdin — voir `lib/providers/prompt-transport.ts`.)

Le format JSON retourne la réponse complète à la fin de l'exécution. Le backend poll le process et détecte la complétion. Les logs bruts sont écrits sur le filesystem (`data/sessions/{sessionId}/logs.json`). Le frontend interroge l'API périodiquement pour mettre à jour le statut (polling court ou SSE sur le statut uniquement).

### 7.3 Data Model

```sql
-- Workspace (implicite, un seul par installation)

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,  -- nanoid
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT DEFAULT 'ideation',  -- ideation | specifying | building | done | archived
  git_repo_path TEXT,             -- chemin vers le repo local
  spec          TEXT,             -- spec complète en markdown (générée par CC)
  imported      INTEGER DEFAULT 0, -- 1 si projet importé depuis un dossier existant
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,      -- nom du fichier original
  content_md  TEXT NOT NULL,      -- contenu converti en markdown
  mime_type   TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE epics (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  priority    INTEGER DEFAULT 0,  -- 0=low, 1=medium, 2=high, 3=critical
  -- Les sept statuts sont le modèle de données du workflow. Ils EXISTENT toujours ;
  -- ils ne sont simplement plus dessinés comme des colonnes (§11.5).
  status      TEXT DEFAULT 'backlog',
              -- backlog | todo | in_progress | review | to_merge | done | released
  position    INTEGER DEFAULT 0,  -- ordre d'exécution DANS le statut (MAX(position)+1 à la
                                  -- création, réécrit 0..n-1 par la route reorder).
                                  -- C'est le contrat d'ordre lu par Full Auto
                                  -- (compareExecutionOrder, lib/kanban/queue.ts) — plus aucune
                                  -- surface d'affichage ne l'écrit depuis un geste de souris.
  branch_name TEXT,               -- branche git associée
  confidence  REAL,               -- 0.0-1.0, score de confiance lors de l'import
  evidence    TEXT,               -- justification du statut (import)
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_stories (
  id                  TEXT PRIMARY KEY,
  epic_id             TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  description         TEXT,
  acceptance_criteria  TEXT,  -- markdown, liste de critères
  status              TEXT DEFAULT 'todo',  -- todo | in_progress | done
  position            INTEGER DEFAULT 0,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,      -- user | assistant
  content     TEXT NOT NULL,
  metadata    TEXT,               -- JSON: model, tokens, mode, etc.
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id     TEXT REFERENCES epics(id),
  status      TEXT DEFAULT 'pending',  -- pending | running | completed | failed | cancelled
  mode        TEXT DEFAULT 'code',     -- plan | code
  prompt      TEXT,               -- prompt envoyé à CC
  logs_path   TEXT,               -- chemin filesystem: data/sessions/{id}/logs.json
  branch_name TEXT,
  worktree_path TEXT,
  started_at  DATETIME,
  completed_at DATETIME,
  error       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,       -- JSON value
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Settings inclut notamment :
--   global_prompt : prompt système ajouté à toutes les sessions CC (tous projets)
```

Ce schéma est le **noyau** posé en v1, pas l'état complet de la base : `lib/db/schema.ts` a
depuis ajouté des colonnes (PR GitHub, `type` feature/bug, `readable_id`, `release_id`,
images…) et des tables entières (dépendances entre tickets, commentaires, findings de revue,
releases, journal d'activité, curseurs de lecture). `lib/db/schema.ts` fait foi.

---

## 8. Features détaillées

### Phase 1 — Brainstorm & Spec Generation (MVP)

#### F1.1 — Création de projet
- Formulaire minimal : nom + description (optionnelle)
- Configuration git optionnelle : chemin vers un repo local existant ou création d'un nouveau repo
- Le projet est créé en statut "ideation"

#### F1.2 — Import de projet existant
- Route `/projects/import`. **Elle n'a plus de point d'entrée dans l'interface** : le dashboard qui portait le bouton « Import existing project » a disparu avec la refonte, le `+` en bout de chips projet mène à `/projects/new` et le bouton « New » de la barre mène à `/tickets/new`. L'écran d'import fonctionne, mais il faut aujourd'hui taper son URL.
- L'utilisateur fournit le **chemin du dossier** du projet existant
- Arij lance Claude Code en mode plan pour analyser le projet :
  1. **Scan du codebase** : structure des fichiers, README, package.json / pyproject.toml / Cargo.toml, CLAUDE.md existant, docs, tests
  2. **Génération de la spec** : CC produit une description du projet, la stack détectée, l'architecture
  3. **Décomposition en épics et US** : CC identifie les modules/features existants et les traduit en épics + US
  4. **Assignation des statuts** : CC évalue pour chaque épic/US si c'est `done` (code existant + tests), `in_progress` (code partiel, TODO, WIP), ou `backlog` (mentionné dans les docs/README mais pas implémenté)
- L'import se fait en deux temps :
  1. CC analyse et produit un plan structuré (JSON)
  2. L'utilisateur **review et valide/ajuste** avant insertion en BDD (preview éditable)
- Le repo git existant est lié au projet (pas de clone, on pointe sur le dossier fourni)

**Prompt d'import (structure) :**

```markdown
# Global Instructions
{settings.global_prompt}

# Task: Analyze existing project

Analyze the codebase in the current directory and produce a structured assessment.

## Output format (JSON)
{
  "project": {
    "name": "detected project name",
    "description": "what this project does",
    "stack": "detected technologies",
    "architecture": "high-level architecture description"
  },
  "epics": [
    {
      "title": "Epic name",
      "description": "What this epic covers",
      "status": "done | in_progress | backlog",
      "confidence": 0.0-1.0,
      "evidence": "why this status (files, tests, TODOs found)",
      "user_stories": [
        {
          "title": "US title",
          "description": "As a... I want... so that...",
          "acceptance_criteria": "...",
          "status": "done | in_progress | todo",
          "evidence": "files/tests that support this status"
        }
      ]
    }
  ]
}

## Rules
- An epic is "done" if the code is functional AND has tests
- An epic is "in_progress" if code exists but is incomplete, has TODOs, or lacks tests
- An epic is "backlog" if mentioned in docs/README/issues but not yet implemented
- Include a confidence score for each status assessment
- Be conservative: prefer "in_progress" over "done" when uncertain
```

#### F1.3 — Upload de documents
- Drag & drop de fichiers dans la zone projet
- Types supportés : `.pdf`, `.docx`, `.md`, `.txt`, `.png`, `.jpg` (OCR basique)
- Conversion automatique en markdown
- Les documents sont stockés en BDD et injectés comme contexte dans les chats
- Visualisation du document converti (markdown rendu)

#### F1.4 — Chat brainstorm
- **Écran plein (`/chat`)**, catégorie Agents de la barre globale. Ce n'est plus un panneau latéral redimensionnable : `app/chat/page.tsx` lit `?project=` et `?conversation=` et monte `components/chat-page/ChatPageView`. Le panneau `components/chat/UnifiedChatPanel` survit uniquement dans le contexte projet de `/projects/:id`.
- Les cartes d'épic du fil et le rail « Créé dans ce chat » ouvrent l'overlay ticket (§11.3) sans quitter la conversation
- Utilise Claude Code en mode `chat` (repo en lecture seule ; les écritures board passent par les outils MCP)
- Le contexte injecté automatiquement inclut : la description du projet, tous les documents uploadés (en markdown), la spec existante (si déjà générée), l'historique des messages récents
- Streaming des réponses en temps réel
- L'utilisateur peut poser des questions, affiner l'idée, demander des alternatives

#### F1.5 — Génération de Spec & Plan
- Bouton "Generate Spec & Plan" dans l'interface du projet
- Lance Claude Code en mode plan avec un prompt structuré qui demande de produire :
  - **Spec projet** : description détaillée, objectifs, contraintes, stack technique recommandée
  - **Épics** : liste ordonnée par priorité, chacune avec titre, description, estimation de complexité
  - **User Stories** : pour chaque épic, liste de US avec format "En tant que... je veux... afin de..." + critères d'acceptation
- La sortie est parsée (format JSON structuré demandé dans le prompt) et insérée en BDD
- L'utilisateur peut ensuite éditer manuellement chaque élément
- Possibilité de relancer la génération (écrase ou merge, au choix de l'utilisateur)

#### F1.6 — Édition de la spec
- Vue spec en markdown avec édition inline
- Chaque épic et US est éditable individuellement
- Ajout/suppression manuelle d'épics et US
- Réordonnancement : **plus de drag & drop**. L'ordre d'exécution est `(rang de statut, position)` — `compareExecutionOrder`, `lib/kanban/queue.ts`. Il se change de deux façons : changer le statut d'un ticket depuis l'overlay (une carte repassée en `in_progress` passe devant tout le `todo`), ou faire réécrire `epics.position` par un agent — la passe **Refinement** repriorise le backlog complet, et l'outil MCP `reorder-tickets` (`app/api/mcp/reorder-tickets`) réordonne une colonne. La priorité (`epics.priority`, éditable dans l'overlay) reste un **filtre / signal de triage**, jamais un critère d'ordonnancement.

---

### Phase 2 — Poste de pilotage

> Livrée initialement comme un board kanban à colonnes avec drag & drop, puis **remplacée** par le
> poste de pilotage décrit ci-dessous. Les statuts n'ont pas bougé : ils ne sont plus dessinés
> comme des colonnes (§11.5).

#### F2.1 — Le poste de pilotage (`/`)
- Page d'accueil de l'application, **multiprojet par défaut**. `components/desk/NowDesk.tsx`, alimenté par un unique `GET /api/control-desk` en polling (4 s ; `hooks/useControlDesk.ts`).
- Cinq **strates d'attention**, dans un ordre fixe d'urgence, chacune sur son fond de couleur :
  1. **WORKING** (turquoise) — les sessions d'agents vivantes, plus deux tuiles épinglées : QUEUED et le cumul du jour. Seule strate qui grandit et qui scrolle.
  2. **YOUR TURN** (corail) — tout ce qui est bloqué sur un humain, dans cet ordre : questions d'agents, échecs, conflits de merge.
  3. **READY TO LAND** (jaune soleil) — les branches qu'un clic « Merge » peut réellement faire atterrir : l'appartenance est `evaluateMergeReadiness().ready`, évalué côté serveur sur les mêmes faits que le sélecteur de merge de Full Auto.
  4. **UP NEXT** (bleu piscine) — l'ordre dans lequel Full Auto va piocher, pas un backlog. Les rangs viennent de `compareExecutionOrder` (`lib/kanban/queue.ts`), qui **est** `compareEpics` (`lib/auto-mode/select.ts`).
  5. Le **composeur** (tilleul) — une ligne de saisie : ⏎ crée le ticket (`status: backlog`, `type: feature`), ⇧⏎ le crée *et* l'envoie à un builder.

  READY TO LAND et UP NEXT sont côte à côte (`grid-cols-2`) ; les trois autres occupent toute la largeur.
- **Une strate vide se replie sur sa ligne de titre.** Un matin sans blocage ne montre pas de carte « tout va bien » : la bande corail fait une ligne.
- Le projet n'est pas un onglet : l'identité projet est une couleur (`projectTone`, quatre tons cycliques) et un chip dans la barre globale. `/projects/:id` rend **le même poste**, pré-filtré à un projet, plus ce que seule cette route peut offrir (pile de toasts, deep links `?ticket=`/`?panel=`/`?night=`, barre de dispatch par lot).
- **Aucun drag & drop.** L'ordre d'UP NEXT est l'ordre d'exécution ; l'écrire depuis un geste de souris réécrirait la file du superviseur (voir F1.6).
- ⌘/Ctrl-clic sur un ticket le **sélectionne** au lieu de l'ouvrir : c'est l'entrée de la sélection multiple (build / review / merge par lot), invisible au repos.

#### F2.2 — L'overlay ticket
- Clic sur un ticket → **modal par-dessus le poste resté vivant** (`components/ticket/TicketOverlay.tsx`). Le poste continue de poller derrière le scrim ; fermer l'overlay ne remonte rien.
- Remplace l'ancien panneau latéral à trois onglets (Details / Code Review / Activity) : tout est sur un seul écran en 7/10 – 3/10.
  - Colonne gauche : description + images, user stories (avec le résultat de grading), activité de l'agent, conversation du ticket.
  - Colonne droite : carte PIPELINE (la chaîne d'étapes, plus le contrôle de statut et de priorité), GIT (branche, diffstat, PR, et **Merge into main** quand le ticket est en `to_merge`), dépendances, agents assignés.
- Le seul écran qui se cache derrière autre chose est le **diff complet**, qui remplace le corps en place.
- Le contrôle de statut liste **toutes** les colonnes du board, y compris celles qui sont refusées, avec la raison du moteur de workflow en `title`. Le serveur reste la source de vérité : son refus s'affiche sous la chaîne.

#### F2.3 — Le registre des tickets (`/tickets`)
- La vue **exhaustive** : tous les tickets, y compris les `released` — c'est le seul écran qui les montre.
- La seule vue en table de l'application. Groupes : actifs, votre tour, en attente, terminés, publiés. Filtres état/projet/recherche, tri, export CSV.
- **Lecture seule** : toute écriture se fait dans l'overlay ticket (§F2.2), qu'une ligne ouvre. Pas de drag & drop, pas d'affordance de réordonnancement.
- `?project=` le restreint à un projet ; sans paramètre il couvre tout l'espace de travail.

#### F2.4 — La barre globale
- **Une seule barre**, montée une fois par `app/layout.tsx` (`components/piscine/TopBar.tsx`). Elle a remplacé le rail latéral gauche (`components/layout/Sidebar.tsx`, supprimé) *et* le header de 60 px que chaque écran dessinait pour lui-même.
- Gauche = identité : le logo « A · Now » ramène toujours au poste, puis les chips projet (le projet actif porte son pastel ; un point qui respire signale un agent vivant). La couleur y dit **qui**, jamais un état.
- Centre = navigation : trois bulles de catégorie, chacune reprenant un fond de strate — **Work** (bleu piscine : Tickets · Spec & Memory · QA · Releases), **Agents** (turquoise : Named agents · Sessions · Chat · Usage), **Réglages** (tilleul : Workspace & Full Auto · Night runs · Notifications · Intégrations). Survol = menu, clic = première entrée atteignable. Le modèle est défini une seule fois dans `lib/piscine/nav.ts`.
- « Now » n'est jamais une catégorie : sur le poste, aucune bulle n'est active.
- Les entrées par projet (Spec & Memory, Releases, Sessions) se résolvent contre le projet de l'URL, sinon le **dernier projet visité** (mémorisé en `localStorage`, revalidé contre la liste des projets), sinon l'unique projet s'il n'y en a qu'un. Sinon elles s'affichent en creux et ne lient pas.
- Droite, identique sur toutes les routes : ⌘K (palette), inbox, l'état Auto, et « New ».

---

### Phase 3 — Claude Code Integration

#### F3.1 — Lancement de Claude Code par épic
- Un ticket à la fois : depuis l'overlay (§F2.2), ou ⇧⏎ dans le composeur du poste (crée puis dispatche)
- Par lot : ⌘/Ctrl-clic sur plusieurs tickets du poste ; la barre de dispatch n'existe que tant qu'une sélection existe, et `hooks/useBatchSelection.ts` résout les dépendances transitives côté serveur
- Ou sans geste du tout : Full Auto pioche dans UP NEXT
- Pour chaque épic sélectionnée :
  1. Vérifie que le repo git est configuré
  2. Crée un worktree + branche (`feature/epic-{id}-{slug}`)
  3. Compose le prompt avec les specs
  4. Spawne le process `claude` en mode code
  5. L'épic passe automatiquement en "In Progress"
- Possibilité de lancer en séquentiel (1 par 1) ou parallèle (N en même temps)

#### F3.2 — Composition du prompt
Le prompt envoyé à Claude Code est structuré ainsi :

```markdown
# Global Instructions
{settings.global_prompt}   <!-- prompt global configurable par l'utilisateur -->

# Project: {project.name}

## Project Specification
{project.spec}

## Reference Documents
{documents.map(d => d.content_md).join('\n---\n')}

## Epic to Implement
### {epic.title}
{epic.description}

### User Stories
{epic.user_stories.map(us => `
- [ ] ${us.title}
  ${us.description}
  Acceptance criteria:
  ${us.acceptance_criteria}
`)}

## Instructions
Implement this epic following the spec above. Create necessary files,
write tests for each user story, and ensure all acceptance criteria are met.
Commit your changes with clear, descriptive commit messages referencing
the epic and user story titles.
```

#### F3.3 — Gestion des sessions
- Chaque lancement crée une `agent_session` en BDD
- Les sessions peuvent être : `pending`, `running`, `completed`, `failed`, `cancelled`
- Bouton "Cancel" pour tuer un process en cours
- Possibilité de relancer une session échouée
- Historique complet des sessions par épic

---

### Phase 4 — Monitoring & Releases

#### F4.1 — Monitoring temps réel
- Le monitoring **est** la première strate du poste : WORKING (§F2.1). Il n'y a plus de vue de monitoring séparée à ouvrir.
- Pour chaque agent actif : projet, ticket, temps écoulé, dernière activité, arrêt de la session
- Polling API côté frontend (`GET /api/control-desk` toutes les 4 s) plutôt qu'une `EventSource` par projet
- Le backend vérifie l'état des process enfants et met à jour la BDD ; `lib/agents/watchdog.ts` marque les sessions muettes
- Historique complet : `/projects/:id/sessions`
- Alertes : les échecs et les questions d'agents tombent dans YOUR TURN et dans l'inbox de la barre globale ; un point qui respire sur le chip du projet signale un agent vivant

#### F4.2 — Logs et détails de session
- Clic sur une session → vue détaillée
- Les logs sont lus depuis le filesystem (`data/sessions/{id}/logs.json`)
- Affichage structuré : prompt envoyé, réponse complète de CC, résultat final
- Export des logs

#### F4.3 — Releases — livré
- `/projects/:id/releases` (`app/projects/[projectId]/releases/page.tsx`) : une bande PROCHAINE RELEASE, des tuiles de chiffres, l'historique
- La prochaine release liste les tickets `done` éligibles et donne la **raison d'exclusion** de ceux qui ne le sont pas (`ticketExclusionReason`)
- Version proposée par bump sémantique (`nextPatchVersion`, `versionBumps`), changelog prévisualisé puis rédigé par un agent nommé
- Publication vers GitHub : `POST /api/projects/:id/releases/:releaseId/publish`
- Les tickets publiés passent en `released` : le registre `/tickets` est le seul écran qui les montre encore

#### F4.4 — Tests et Preview (V2+)
- Détection automatique du framework (Next.js, Vite, etc.)
- Bouton "Run tests" → exécute la commande de test du projet
- Bouton "Preview" → lance le serveur de dev et affiche dans un iframe
- Rapport de tests intégré à la vue épic

---

## 9. Structure des routes (Next.js 16 App Router)

```
app/
├── layout.tsx                    # Racine : TopBar globale + un unique conteneur scrollable
├── globals.css                   # Tokens Piscine (:root jour / .dark nuit)
├── page.tsx                      # "/" — poste de pilotage, multiprojet
├── tickets/
│   ├── page.tsx                  # Registre exhaustif (?project= pour filtrer)
│   └── new/page.tsx
├── qa/
│   └── page.tsx                  # QA transverse (findings de revue)
├── chat/
│   └── page.tsx                  # Chat plein écran (?project=, ?conversation=)
├── agents/
│   ├── layout.tsx                # Deuxième rangée : Named agents · Assignments ·
│   │                             #   Prompts · Limits · Usage
│   ├── page.tsx                  # Atelier des agents nommés
│   ├── assignments/page.tsx
│   ├── prompts/page.tsx
│   └── limits/page.tsx
├── usage/
│   └── page.tsx                  # Observatoire de consommation
├── inbox/
│   └── page.tsx
├── settings/
│   ├── layout.tsx                # Onglets : Workspace · Agents · Pipeline ·
│   │                             #   Intégrations · Apparence
│   ├── page.tsx                  # Workspace, Full Auto, night runs, notifications, budget
│   ├── pipeline/page.tsx
│   ├── integrations/page.tsx
│   └── appearance/page.tsx
├── piscine-preview/
│   └── page.tsx                  # Harnais de dev (toutes les primitives) — pas un écran produit
├── projects/
│   ├── new/page.tsx              # Création de projet
│   ├── import/page.tsx           # Import projet existant (path selector → preview → validate)
│   └── [projectId]/
│       ├── layout.tsx            # Deep links ?ticket= ?panel= ?night= ?nightRun= ?deleted=
│       ├── page.tsx              # Le MÊME poste, pré-filtré au projet
│       ├── spec/page.tsx         # Spec & Memory
│       ├── documents/page.tsx
│       ├── sessions/
│       │   ├── page.tsx          # Liste des sessions
│       │   ├── [sessionId]/page.tsx
│       │   └── chat/[conversationId]/page.tsx
│       ├── releases/page.tsx
│       ├── qa/page.tsx           # QA exploratoire par projet (≠ /qa)
│       ├── stories/[storyId]/page.tsx
│       └── frictions/, git-sync/, github-issues/, settings/
├── api/
│   ├── projects/
│   │   ├── route.ts              # GET (list), POST (create)
│   │   ├── import/
│   │   │   └── route.ts          # POST (import existing project → lance CC plan mode)
│   │   └── [projectId]/
│   │       ├── route.ts          # GET, PATCH, DELETE
│   │       ├── documents/
│   │       │   └── route.ts      # GET, POST (upload)
│   │       ├── epics/
│   │       │   ├── route.ts      # GET, POST
│   │       │   └── [epicId]/
│   │       │       └── route.ts  # PATCH, DELETE
│   │       ├── user-stories/
│   │       │   └── route.ts      # CRUD
│   │       ├── chat/
│   │       │   └── route.ts      # GET history, POST message (lance CC plan mode, retourne JSON)
│   │       ├── generate-spec/
│   │       │   └── route.ts      # POST → lance CC plan mode
│   │       ├── build/
│   │       │   └── route.ts      # POST → lance CC code mode
│   │       └── sessions/
│   │           ├── route.ts      # GET list
│   │           ├── [sessionId]/
│   │           │   └── route.ts  # GET detail + logs, DELETE (cancel)
│   │           └── active/
│   │               └── route.ts  # GET sessions actives (polling)
│   ├── control-desk/
│   │   └── route.ts              # GET — LA lecture du poste de pilotage : un seul appel
│   │                             #   agrège working / your turn / ready to land / up next /
│   │                             #   today pour tous les projets (voir lib/control-desk/)
│   └── settings/
│       └── route.ts              # GET, PATCH settings (prompt global, etc.)
```

Le sous-arbre `api/` ci-dessus est le noyau v1. Les namespaces réellement présents aujourd'hui
sont : `agent-config`, `control-desk`, `dashboard`, `inbox`, `mcp`, `notifications`, `projects`,
`providers`, `qa`, `settings`, `tickets`, `usage` — et sous `projects/[projectId]/` une
trentaine de sous-routes (dépendances, pipeline, refinement, releases, review-resolution,
worktrees, memory, prompt-anatomy…). Le système de fichiers fait foi.

---

## 10. Structure du projet (fichiers)

```
arij/
├── app/                          # Next.js 16 App Router (voir section 9)
├── components/
│   ├── ui/                       # shadcn/ui components
│   ├── piscine/                  # Le design system : TopBar, StrataBand, BandHeader,
│   │                             #   PillButton, IdentityChip, Mono… + index.ts (barrel)
│   ├── desk/                     # Le poste de pilotage
│   │   ├── NowDesk.tsx           #   la page : cinq strates
│   │   ├── WorkingBand.tsx       #   turquoise — sessions vivantes (+ QueuedTile, TodayTile)
│   │   ├── YourTurnBand.tsx      #   corail — questions / échecs / conflits (AttentionRow)
│   │   ├── ReadyToLandBand.tsx   #   soleil — branches mergeables
│   │   ├── UpNextBand.tsx        #   piscine — l'ordre de pioche de Full Auto
│   │   ├── DeskComposer.tsx      #   tilleul — ⏎ crée, ⇧⏎ crée et dispatche
│   │   └── DeskCommandPalette.tsx#   ⌘K (monté par la TopBar)
│   ├── ticket/                   # L'overlay ticket (remplace kanban/EpicDetail)
│   │   ├── TicketOverlay.tsx     #   la modale 7/3
│   │   ├── TicketOverlayProvider.tsx  # le contexte que les écrans montent
│   │   ├── PipelineCard.tsx, StatusControl.tsx, GitBand.tsx,
│   │   └── UserStoriesBand.tsx, ConversationBand.tsx, DependenciesBand.tsx…
│   ├── tickets-registry/         # /tickets — la seule vue en table
│   ├── qa/                       # /qa — findings de revue transverses
│   ├── chat-page/                # /chat plein écran
│   ├── chat/                     # UnifiedChatPanel — le panneau projet qui subsiste
│   ├── agents-workshop/          # /agents
│   ├── settings-piscine/         # /settings, une bande par sujet
│   ├── usage/, releases/, night/, auto-mode/, monitor/,
│   │   review/, dependencies/, session-live/, shared/…
│   ├── kanban/                   # PLUS DE BOARD : ce qui reste sont des dialogues et des
│   │                             #   contrôles réutilisés (EpicCreateDialog, BugCreateDialog,
│   │                             #   QuickCapture, InlineEdit, RefinementButton, GitSyncBadge)
│   ├── import/
│   │   ├── FolderSelector.tsx     # Sélection du dossier projet
│   │   ├── ImportPreview.tsx      # Preview des épics/US détectées (éditable)
│   │   └── ImportProgress.tsx     # Progression de l'analyse CC
│   ├── documents/
│   │   ├── UploadZone.tsx
│   │   └── DocumentViewer.tsx
│   └── spec/                      # Spec & Memory : SpecBand, MemoryPanel, DocsCard,
│                                  #   SuggestionBand, PromptAnatomyBand…
├── lib/
│   ├── db/
│   │   ├── schema.ts             # Drizzle schema
│   │   ├── migrations/           # Migrations écrites À LA MAIN (voir CLAUDE.md)
│   │   └── index.ts              # DB connection
│   ├── piscine/
│   │   ├── tokens.ts             # STRATA, STRATUM, PROJECT_TONES — le pendant TS de globals.css
│   │   └── nav.ts                # LE modèle de navigation : catégories, entrées, résolution
│   ├── control-desk/
│   │   ├── aggregate.ts          # deriveWorking / deriveUpNext / deriveReadyToLand…
│   │   └── types.ts              # ControlDeskPayload
│   ├── kanban/                   # TOUJOURS VIVANT malgré son nom : la logique board sans UI
│   │   ├── queue.ts              #   compareExecutionOrder (= compareEpics de auto-mode)
│   │   ├── merge-readiness.ts    #   evaluateMergeReadiness — l'appartenance à READY TO LAND
│   │   ├── status-transitions.ts #   les transitions offertes par le contrôle de statut
│   │   └── filters.ts, selection.ts, awaiting-reply.ts, activity-feed.ts, reorder.ts
│   ├── workflow/                 # Le moteur : engine.ts, reorder.ts, merge-failure.ts…
│   ├── auto-mode/                # Full Auto : select.ts (la pioche), registry.ts (in-process)
│   ├── claude/
│   │   ├── spawn.ts              # Spawn claude CLI process
│   │   ├── json-parser.ts        # Parse JSON output de CC
│   │   ├── prompt-builder.ts     # Compose prompts from specs + global prompt
│   │   └── process-manager.ts    # Manage running processes, polling statut
│   ├── providers/                # Registre des CLI supportés et de leurs options
│   ├── git/
│   │   ├── manager.ts            # Git operations (worktrees, branches)
│   │   └── utils.ts
│   ├── converters/
│   │   ├── docx-to-md.ts
│   │   ├── pdf-to-md.ts
│   │   └── image-to-md.ts        # OCR basique
│   ├── dependencies/, refinement/, tickets-registry/, qa/, mcp/, night/, usage/
│   └── utils/
│       ├── nanoid.ts
│       └── markdown.ts
├── hooks/
│   ├── useControlDesk.ts         # LA lecture du poste (polling 4 s)
│   ├── useTicketOverlayData.ts   # Ce que l'overlay ticket charge
│   ├── useBatchSelection.ts      # Sélection multiple + dépendances transitives
│   ├── useInbox.ts, useProjects.ts, useAutoModeArmed.ts   # ce que lit la TopBar
│   ├── useChat.ts
│   └── useAgentPolling.ts        # Polling statut des sessions CC
├── drizzle.config.ts
├── next.config.ts
├── package.json
├── tsconfig.json
├── data/                         # Données locales (gitignored)
│   ├── arij.db                   # SQLite database
│   └── sessions/                 # Logs des sessions CC
│       └── {sessionId}/
│           └── logs.json         # Sortie JSON complète de CC
├── CLAUDE.md                     # Instructions pour CC quand il travaille sur Arij lui-même
└── README.md
```

---

## 11. UX / Wireframes textuels

> Cette section décrit l'interface **après** la refonte « Piscine ». Les captures de
> `public/screenshots/` (`kanban.png`, `chat.png`, `dashboard.png`, `ticket.png`) montrent
> l'interface **précédente** et n'ont pas été regénérées : elles ne documentent plus les
> écrans ci-dessous.

### 11.1 La barre globale (sur toutes les routes)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ [A · Now]  ●Ledger  Arij  Piscine     ( Work ▾)( Agents ▾)( Réglages ▾)    │
│                                                     ⌘K   ✉ 3   ∞ Auto  + New│
└────────────────────────────────────────────────────────────────────────────┘
   └ identité : logo + chips projet      └ navigation      └ actions (fixes)
     (● = un agent tourne)                 (3 bulles)
```

Montée une fois par `app/layout.tsx`, au-dessus d'un unique conteneur scrollable. Il n'y a plus
de rail latéral, et aucun écran ne dessine son propre header de 60 px : les contrôles propres à
un écran vivent dans une **deuxième rangée** à l'intérieur de son contenu (onglets d'`/agents`,
onglets de `/settings`, rangée de contrôles du poste).

Deux « + » distincts, à ne pas confondre : le rond pointillé en bout de chips crée un **projet**
(`/projects/new`) ; le bouton **New** à droite crée un **ticket** (`/tickets/new`). Les menus
Work et Agents portent en plus un panneau de contexte — le digest CE MATIN pour Work, la liste
EN CE MOMENT des agents vivants pour Agents ; Réglages n'en a pas et se dessine en une colonne.

### 11.2 Le poste de pilotage (`/`, page d'accueil)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ┌ WORKING ────────────────────────────────────── turquoise ─ 3 ───────────┐ │
│ │ ●Ledger  E-042 Paiements Stripe   Marge · écrit stripe-service.ts  12:04│ │
│ │ ●Arij    B-108 Flake du sélecteur Basile · lance la suite         03:41 │ │
│ │ ●Piscine E-011 Import GitHub      Nour  · attend le build         01:12 │ │
│ │ ┌ QUEUED · 2 ────────────┐ ┌ TODAY · 7 mergés · $4.20 ───────────────┐  │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│ ┌ YOUR TURN ──────────────────────────────────── corail ─── 2 ───────────┐ │
│ │ ASKS YOU  E-039  « Quelle lib de dates ? »        [répondre] [→ dev]   │ │
│ │ CONFLICT  E-021  feature/epic-021 vs main         [résoudre] [diff]    │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│ ┌ READY TO LAND ── soleil ─ 3 ─┐ ┌ UP NEXT ──── piscine ─ ordre de pioche ┐│
│ │ E-017 auth-oauth  +412 −38   │ │ Ledger   1 E-044   2 E-045   3 E-051  ││
│ │ E-030 csv-export  +96  −4    │ │ Arij     1 B-112   2 E-089   ·        ││
│ │ [Tout faire atterrir]        │ │ Piscine  1 E-013   ·         ·        ││
│ └──────────────────────────────┘ └───────────────────────────────────────┘│
│ ┌ tilleul ───────────────────────────────────────────────────────────────┐ │
│ │ Décris une fonctionnalité…            [projet ▾] [agent ▾]  ⏎ / ⇧⏎     │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

Ordre fixe, de haut en bas : **ce qui tourne** → **ce qui vous attend** → **ce qui peut
atterrir** | **ce qui vient ensuite** → **ce que vous voulez ajouter**. Une strate sans contenu
se replie sur sa ligne de titre : un matin sans blocage, la bande corail fait une ligne.

Seule WORKING grandit ; les autres se dimensionnent à leur contenu. YOUR TURN plafonne à 40 vh
et scrolle au-delà de trois lignes, pour qu'une pile de questions ne pousse jamais WORKING hors
de l'écran.

`/projects/:id` rend **exactement ce poste**, filtré à un projet, plus les toasts, les deep
links et la barre de dispatch par lot.

### 11.3 L'overlay ticket (par-dessus le poste resté vivant)

```
┌──────────────────────────────── scrim ─────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ ← E-017 · Auth OAuth                          [agent ▾] [supprimer]  │  │
│  ├──────────────────────────── 7/10 ─────────┬────── 3/10 ─────────────┤  │
│  │ DESCRIPTION + images                       │ PIPELINE                │  │
│  │ USER STORIES  3/5 · grading                │  ○─●─●─○─○  [statut ▾]  │  │
│  │ ACTIVITÉ DE L'AGENT   (timeline, live)     │ GIT                     │  │
│  │ CONVERSATION                               │  feature/epic-017       │  │
│  │  › …                                       │  +412 −38   [diff]      │  │
│  │  [écrire un commentaire]                   │  [Merge into main]      │  │
│  │                                            │ DÉPENDANCES · AGENTS    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

Le poste continue de vivre et de poller derrière le scrim ; fermer l'overlay ne remonte rien.
Plus d'onglets Details / Code Review / Activity : la seule chose qui se cache derrière autre
chose est le diff complet, qui remplace le corps en place.

### 11.4 Les autres écrans

| Route | Ce que c'est |
|-------|--------------|
| `/tickets` | Le registre exhaustif. Seule vue en table, seul écran qui montre les tickets `released`. Lecture seule : les écritures passent par l'overlay. |
| `/qa` | Les findings de revue, tous projets confondus : verdicts, checklist, arbitrage. À ne pas confondre avec `/projects/:id/qa`, qui est l'agent de QA exploratoire et ses rapports. |
| `/chat` | Le chat en plein écran (avant : un panneau latéral). Les cartes d'épic du fil ouvrent l'overlay. |
| `/agents` | L'atelier des agents nommés (avant : une feuille latérale de 480 px). Deuxième rangée : Named agents · Assignments · Prompts · Limits · Usage. |
| `/usage` | L'observatoire de consommation. |
| `/settings` | Paramètres, une strate par sujet : Workspace → Full Auto → Night runs → Notifications \| Budget, et **un seul** couple Discard / Save en pied. Onglets : Workspace · Agents · Pipeline · Intégrations · Apparence. |
| `/projects/:id/spec` | Spec & Memory : la spec, la mémoire, les suggestions d'agent, les docs, l'anatomie du prompt. |
| `/projects/:id/releases` | Prochaine release, chiffres, historique (§F4.3). |
| `/projects/:id/sessions` | L'historique des sessions d'agents, night runs compris. |
| `/piscine-preview` | Harnais de développement : toutes les primitives du design system. Pas un écran produit. |

### 11.5 Les statuts existent toujours — ils ne sont simplement plus des colonnes

C'est le point le plus facile à mal lire dans tout ce document, alors il est écrit une fois
clairement :

- Le workflow **n'a pas changé**. Un ticket traverse toujours
  `backlog → todo → in_progress → review → to_merge → done → released`
  (`KANBAN_COLUMNS`, `lib/types/kanban.ts`), les transitions sont toujours validées par le
  moteur côté serveur, et le merge vaut toujours approbation.
- Ce qui a disparu, c'est **le dessin** : plus de colonnes, plus de cartes qu'on fait glisser
  d'une colonne à l'autre. Le statut se lit dans la chaîne PIPELINE de l'overlay et se change
  dans son menu, qui liste toutes les colonnes — y compris celles que le moteur refuse, avec
  sa raison.
- Le poste range par **ce que le travail demande à l'utilisateur**, pas par état : un même
  ticket `in_progress` apparaît dans WORKING s'il a une session vivante, dans YOUR TURN si son
  agent pose une question ou a échoué, et dans UP NEXT s'il attend simplement d'être repris. Le
  statut ne détermine pas à lui seul où le ticket se trouve à l'écran.
- Le mot « board » reste juste partout ailleurs : `arji.json` est toujours l'export du board,
  `lib/kanban/` héberge toujours la logique vivante (rangs de file, éligibilité au merge,
  transitions, filtres), et les lignes en base sont toujours des lignes de board.

---

## 12. Contraintes et dépendances

| Contrainte | Détail |
|------------|--------|
| **Claude Code installé** | L'app nécessite `claude` dans le PATH, authentifié |
| **Git installé** | Requis pour la gestion des worktrees et branches |
| **Node.js ≥ 20.9** | Requis par Next.js 16 |
| **Espace disque** | Les worktrees Git multiplient l'espace utilisé par projet |
| **Limites souscription** | Le rate limiting de la souscription Claude Pro/Max s'applique |
| **Pas de multi-utilisateur** | V1 est mono-utilisateur, local uniquement |

---

## 13. Métriques de succès (pour l'open source)

- **Adoption** : 100+ stars GitHub dans les 3 premiers mois
- **Utilisabilité** : un nouveau user peut lancer son premier build Claude Code en < 10 minutes
- **Stabilité** : < 1% de sessions Claude Code qui échouent pour des raisons liées à Arij (pas à CC lui-même)
- **Performance** : interface réactive (< 100 ms pour ouvrir un ticket ou changer son statut), streaming sans lag perceptible

---

## 14. Risques et mitigations

| Risque | Impact | Mitigation |
|--------|--------|------------|
| Claude Code CLI change son format de sortie | 🔴 Élevé | Abstraire le parsing dans un module isolé (`stream-parser.ts`), versionner la compatibilité |
| Rate limiting souscription trop restrictif pour le multi-agent | 🟡 Moyen | Permettre le lancement séquentiel, ajouter un système de file d'attente |
| Anthropic interdit l'usage du CLI par des apps tierces | 🔴 Élevé | Suivre les ToS, prévoir un fallback vers l'Agent SDK + API key |
| Conflits git entre worktrees | 🟡 Moyen | Stratégie de branches isolées par épic, merge conflict detection |
| Complexité du prompt pour la spec generation | 🟡 Moyen | Itérer sur le prompt engineering, permettre à l'utilisateur de customiser le prompt template |
| Import imprécis sur gros projets (mauvais statuts) | 🟡 Moyen | Preview éditable avant validation, score de confiance par épic, possibilité de relancer l'analyse sur un sous-ensemble |

---

## 15. Roadmap

| Phase | Scope | Durée estimée |
|-------|-------|---------------|
| **Phase 1** — MVP Brainstorm & Spec | Création projet, **import projet existant**, upload docs, chat CC plan mode, génération spec, édition manuelle | 3-4 semaines |
| **Phase 2** — Kanban | Board kanban, drag & drop, vue épic détaillée, dashboard multi-projet | 1-2 semaines |
| **Refonte « Piscine »** (août 2026) | Le board kanban, le rail latéral, les headers par écran et le drag & drop sont retirés ; poste de pilotage à cinq strates, overlay ticket, barre globale, registre `/tickets`, chat / agents / QA / usage en écrans pleins, design system partagé | livrée |
| **Phase 3** — Build Integration | Lancement CC par épic, gestion worktrees/branches, streaming monitoring | 2-3 semaines |
| **Phase 4** — Polish & Release | Releases, changelogs, notifications, documentation, publication npm | 1-2 semaines |
| **V2** | Tests intégrés, preview deployments, templates de prompts, plugins | Futur |

---

## 16. Décisions prises

| Question | Décision |
|----------|----------|
| **Nom du projet** | **Arij** |
| **Format de sortie CC** | JSON (pas de streaming). Polling pour le suivi de statut. |
| **Worktrees vs branches** | **Worktrees** — isolation complète par épic |
| **Persistance des logs** | **Filesystem** (`data/sessions/{id}/logs.json`) — référence en BDD |
| **Templates de prompts** | Pas d'exposition par projet. Un **prompt global** configurable (settings) injecté dans toutes les sessions CC. |
| **Écran d'accueil : board ou poste ?** | **Poste de pilotage à strates d'attention.** Ce sont les agents qui font les transitions ; un board à colonnes demandait à l'utilisateur de lire un état qu'il ne pilote plus. |
| **Statuts** | **Conservés tels quels** en base et dans le moteur de workflow. Seule leur représentation en colonnes disparaît (§11.5). |
| **Drag & drop** | **Retiré partout.** `epics.position` est le contrat d'ordre d'exécution de Full Auto ; un ordre d'affichage réécrit dedans réordonnerait silencieusement la file du superviseur. La repriorisation passe par le changement de statut, par la passe Refinement ou par l'outil MCP `reorder-tickets`. |
| **Navigation** | **Une seule barre globale**, montée par le layout racine. Ni rail latéral, ni header par écran ; les contrôles propres à un écran forment sa deuxième rangée. |
| **Licence** | **MIT** |

---

*Ce document sert de base pour le développement de Arij. Il sera mis à jour au fur et à mesure de l'avancement.*