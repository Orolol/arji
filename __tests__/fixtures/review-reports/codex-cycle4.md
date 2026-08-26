**Code Review**

# Rapport de revue

Périmètre : ensemble de l’epic, jusqu’au commit `0b2f7e0`.

## Findings

### 1. Créations de bug multiples via Entrée

- **Severity:** Major
- **Location:** [components/kanban/BugCreateDialog.tsx:71](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/components/kanban/BugCreateDialog.tsx:71)
- **Description:** `handleSubmit()` ne vérifie pas `submitting`. Les boutons sont désactivés après rendu, mais le champ titre reste actif et Entrée rappelle directement la fonction. Une seconde pression pendant un POST peut créer un doublon ; après « Create And Fix », le premier bug peut être dispatché tandis que le second reste sans agent.
- **Recommendation:** Ajouter un verrou synchrone via `useRef`, acquis avant le premier `await` et libéré dans `finally`. Tester plusieurs pressions Entrée pendant une requête suspendue.

### 2. Absence de contrat de validation sur `POST /bugs`

- **Severity:** Major
- **Location:** [app/api/projects/[projectId]/bugs/route.ts:51](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/app/api/projects/[projectId]/bugs/route.ts:51)
- **Description:** Le body reste non typé. Un titre `"   "` est accepté ; description, priorité, `linkedEpicId` et nombre d’images ne sont pas bornés. Un JSON invalide ou `null` peut lever sans réponse structurée, un lien peut viser un epic d’un autre projet, et un projet inconnu atteint la contrainte FK puis retourne un 500 au lieu d’un 404 `{ error }`.
- **Recommendation:** Introduire un `createBugSchema` avec `validateBody`, aligner les limites sur les epics, vérifier le projet et l’epic lié avec les helpers `*Or404`, gérer les erreurs DB et tester zéro insertion après chaque rejet.

### 3. Limites incohérentes pour les stories imbriquées

- **Severity:** Major
- **Location:** [lib/validation/schemas.ts:58](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/lib/validation/schemas.ts:58)
- **Description:** `userStoryInput` exige seulement un titre non vide, tandis que les routes normales plafonnent le titre à 500 caractères et la description/les critères à 10 000. La création manuelle ou chat peut donc persister des données que les routes d’édition refusent et injecter du contenu non borné dans les prompts.
- **Recommendation:** Factoriser les règles avec les schémas de story, les refléter dans `manual-epic-form.ts` avec des erreurs inline, et ajouter des tests aux limites côté client et API.

### 4. Les captures de bug ne sont jamais supprimées

- **Severity:** Major
- **Location:** [app/api/projects/[projectId]/chat/upload/route.ts:47](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/app/api/projects/[projectId]/chat/upload/route.ts:47)
- **Description:** Chaque capture crée une ligne `chat_attachments` avec `chatMessageId = null`. Le bug ne conserve qu’un chemin JSON, sans FK vers le ticket ou le projet. Retirer une miniature, abandonner le formulaire, supprimer le bug ou supprimer le projet laisse donc la ligne et le fichier sur disque définitivement.
- **Recommendation:** Ajouter une relation d’ownership explicite — avec migration SQL manuscrite si nécessaire — puis nettoyer lignes et fichiers lors de l’abandon, du retrait et des suppressions de ticket/projet. Couvrir ce cycle de vie par un test d’intégration.

### 5. Le teardown E2E ignore l’échec de suppression du projet

- **Severity:** Minor
- **Location:** [e2e/fixtures/arij-project.ts:188](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/e2e/fixtures/arij-project.ts:188)
- **Description:** La réponse de `request.delete()` n’est pas vérifiée. Un échec peut laisser le projet dans SQLite alors que le dépôt et les uploads sont supprimés, sans faire échouer le test.
- **Recommendation:** Vérifier la réponse et l’absence finale de la ligne projet, tout en conservant les autres nettoyages dans des blocs `finally`.

## Évaluation du checklist

1. **Readability:** No issues found.
2. **DRY Principle:** No issues found. Le hook d’upload, le lightbox et la vérification des uploads sont correctement mutualisés.
3. **Error Handling:** Findings 1, 2 et 4.
4. **Performance:** Findings 3 et 4 — contenu non borné et accumulation permanente de fichiers.
5. **Naming Conventions:** No issues found.
6. **Type Safety:** Finding 2.
7. **Testing:** Les scénarios nominaux sont solides, mais les régressions décrites par les findings 1, 3, 4 et 5 ne sont pas couvertes.
8. **API Design:** Findings 2, 3 et 4.

## Vérification

- `git diff --check main...HEAD` : réussi.
- `npx tsc --noEmit --incremental false` : réussi.
- ESLint ciblé : aucune erreur, trois avertissements `no-img-element`.
- Playwright découvre correctement les 5 tests.
- Vitest et l’exécution Playwright sont bloqués par le sandbox en lecture seule lors de la création de leurs répertoires temporaires.
- Le dépôt structuré des findings auprès d’Arij a été tenté, mais refusé par la politique d’approbation `never`.

**Summary:** 0 Critical, 4 Major, 1 Minor, 0 Suggestions.

**Overall Verdict: Changes Requested**