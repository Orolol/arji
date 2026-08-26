**Code Review**

# Rapport de revue

La création manuelle d’epic et le parcours nominal des captures sont bien structurés, mais six problèmes bloquants subsistent.

## Findings

### 1. Les uploads concurrents peuvent perdre ou ressusciter des images

- **Severity:** Major
- **Location:** [hooks/useImageAttachments.ts:92](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/hooks/useImageAttachments.ts:92)
- **Description:** `uploading` est un booléen par lot, tandis que paste/drop restent actifs pendant un transfert. Si deux lots se chevauchent, le premier terminé remet `uploading` à `false`, permettant de soumettre avant la fin du second. Un résultat tardif peut également repeupler les pièces jointes après `clear()` ou la fermeture.
- **Recommendation:** Employer un compteur d’opérations ou sérialiser les transferts, invalider les résultats après `clear()`/unmount, puis tester deux uploads terminant dans l’ordre inverse et une fermeture pendant l’upload.

### 2. Le mode Team omet les captures dans le prompt

- **Severity:** Major
- **Location:** [lib/claude/prompt-builder.ts:625](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/lib/claude/prompt-builder.ts:625)
- **Description:** `TeamEpic` ne contient ni `projectId` ni `images`, et `buildTeamBuildPrompt()` n’appelle pas `ticketImagesSection()`. Un batch « Build as Team » contenant un bug envoie donc l’agent sans ses captures.
- **Recommendation:** Étendre `TeamEpic` avec ces champs, les alimenter dans la route batch, injecter la section pour chaque epic et couvrir ce chemin par un test.

### 3. Entrée peut déclencher plusieurs créations du même bug

- **Severity:** Major
- **Location:** [components/kanban/BugCreateDialog.tsx:72](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/components/kanban/BugCreateDialog.tsx:72)
- **Description:** `handleSubmit()` ne vérifie pas `submitting`. Les boutons sont désactivés, mais le champ titre continue d’appeler `handleSubmit("create")` sur Entrée. Pendant une requête, notamment « Create And Fix », cela peut émettre un second POST et créer deux bugs. Ce comportement préexistait, mais reste ouvert sur la modale désormais modifiée.
- **Recommendation:** Ajouter une garde de réentrance fiable, idéalement avec une ref synchrone, et tester Entrée pendant une requête suspendue.

### 4. La route de création de bug n’a pas de contrat de validation

- **Severity:** Major
- **Location:** [app/api/projects/[projectId]/bugs/route.ts:42](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/app/api/projects/[projectId]/bugs/route.ts:42)
- **Description:** Le body est non typé et `if (!body.title)` accepte `"   "`. La priorité, la description et `linkedEpicId` ne sont pas validés non plus. L’API peut ainsi retourner `201` pour une carte vide ou transmettre des types invalides à SQLite. Le défaut du titre est préexistant, mais demeure sur la route étendue.
- **Recommendation:** Introduire un schéma Zod via `validateBody`, avec trim, limites de longueur, priorité entière entre 0 et 3 et tests garantissant zéro insertion après rejet.

### 5. Des références d’images inexistantes sont acceptées

- **Severity:** Major
- **Location:** [app/api/projects/[projectId]/bugs/route.ts:24](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/app/api/projects/[projectId]/bugs/route.ts:24)
- **Description:** La validation contrôle uniquement la forme du chemin. `data/uploads/<projectId>/missing.png` est persisté avec `201`, alors que la route d’affichage exige une ligne `chat_attachments` image correspondante. La miniature renverra donc 404 et le prompt agent référencera un fichier inexistant.
- **Recommendation:** Vérifier chaque chemin contre `chat_attachments`, son MIME et, idéalement, l’existence du fichier. Toute référence invalide doit rejeter la création entière.

### 6. Les nouveaux E2E laissent des données et fichiers orphelins

- **Severity:** Major
- **Location:** [e2e/fixtures/arij-project.ts:83](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/e2e/fixtures/arij-project.ts:83)
- **Description:** Le teardown supprime le projet et le dépôt temporaire, mais pas les uploads sous `data/uploads/<projectId>`. Leur ligne `chat_attachments` porte `chat_message_id = NULL` et aucune FK projet, donc le DELETE projet ne la cascade pas. Chaque exécution du scénario bug peut polluer durablement l’instance SQLite locale.
- **Recommendation:** Lancer le serveur E2E avec une base/data root temporaire dédiée, ou supprimer explicitement les lignes et le répertoire dans un `finally`, avec assertion du nettoyage.

### 7. Playwright dépend de Chrome système par défaut

- **Severity:** Minor
- **Location:** [playwright.config.ts:12](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/playwright.config.ts:12)
- **Description:** Le défaut global est désormais `channel: "chrome"` pour contourner une limitation de cet hôte. Une machine ayant installé le Chromium Playwright standard, mais pas Google Chrome, échouera sur `npm run test:e2e`.
- **Recommendation:** Conserver Chromium bundlé par défaut et sélectionner Chrome explicitement via `PLAYWRIGHT_CHANNEL=chrome` sur l’hôte concerné.

## Évaluation du checklist

1. **Readability:** No issues found.
2. **DRY Principle:** No issues found. Le hook, les miniatures et le lightbox sont correctement mutualisés.
3. **Error Handling:** Findings 1 et 3.
4. **Performance:** Finding 6 — accumulation de données et fichiers.
5. **Naming Conventions:** No issues found.
6. **Type Safety:** Finding 4.
7. **Testing:** Findings 1, 2, 3, 6 et 7.
8. **API Design:** Findings 4 et 5.

## Vérification

- `git diff --check main...HEAD` : réussi.
- `npx tsc --noEmit --incremental false` : réussi.
- ESLint ciblé : aucune erreur, deux avertissements `no-img-element`.
- Playwright découvre bien 5 tests.
- Vitest et l’exécution Playwright sont bloqués par le sandbox en lecture seule avant exécution effective.
- Le dépôt structuré des findings auprès d’Arij a été tenté, mais refusé par la politique d’approbation `never`.

**Summary:** 0 Critical, 6 Major, 1 Minor, 0 Suggestions.

**Overall Verdict: Changes Requested**