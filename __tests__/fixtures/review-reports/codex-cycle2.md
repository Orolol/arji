**Code Review**

# Rapport de revue

Périmètre examiné : commits `fc7d2ec`, `57c25e9` et `fec93d4`, ainsi que les routes, détails de ticket, prompts et tests concernés par l’ensemble de l’epic.

## Findings

### 1. La création de bug ne prend toujours pas en charge les images

- **Severity:** Major
- **Location:** `components/kanban/BugCreateDialog.tsx:58`
- **Description:** La modale ne transmet que `title`, `description` et `priority`. Aucun upload, paste, drag & drop, aperçu, suppression ou retour d’erreur MIME/taille n’est présent. Le champ backend `images` reste donc inaccessible depuis l’interface.
- **Recommendation:** Extraire le pipeline du chat dans un hook/composant partagé, l’utiliser dans cette modale et envoyer les références normalisées pour `Create Bug` comme pour `Create And Fix`.

### 2. Les images persistées ne sont jamais affichées

- **Severity:** Major
- **Location:** `components/kanban/EpicDetail.tsx:430`
- **Description:** `useEpicDetail` récupère `epic.images`, mais le détail passe directement de la description au résumé agent sans lire ce champ. Un bug créé via l’API avec des images ne présente donc aucune miniature.
- **Recommendation:** Ajouter un normaliseur JSON tolérant les valeurs nulles, anciennes ou malformées, puis afficher des miniatures accessibles ouvrant une vue agrandie.

### 3. Les captures sont absentes de tous les prompts agent

- **Severity:** Major
- **Location:** `lib/claude/prompt-builder.ts:56`
- **Description:** `PromptEpic` et `TeamEpic` ne représentent pas les pièces jointes. Les parcours build, ticket-build, review, pipeline et team-build n’injectent donc aucun chemin d’image. Cela affecte notamment Send to Dev et Create And Fix, indépendamment du provider.
- **Recommendation:** Étendre les projections de prompt, centraliser une section de pièces jointes et couvrir tous les builders avec et sans images.

### 4. La couverture demandée pour les nouveaux parcours est absente

- **Severity:** Major
- **Location:** `e2e/home.spec.ts:3`
- **Description:** Playwright ne contient que trois tests smoke du dashboard. Les scénarios epic manuelle avec deux stories et bug avec image collée n’existent pas. Aucun test unitaire ne couvre non plus la normalisation ou le filtrage MIME/taille des pièces jointes.
- **Recommendation:** Ajouter les deux scénarios E2E et des tests Vitest couvrant filtrage, normalisation, persistance, restitution et injection dans les prompts.

### 5. L’API retourne un succès partiel pour des stories invalides

- **Severity:** Major
- **Location:** `app/api/projects/[projectId]/epics/route.ts:207`
- **Description:** Le schéma `min(1)` accepte un titre composé d’espaces, puis ce filtre supprime silencieusement la story. Une requête contenant des stories valides et une story `"   "` retourne ainsi `201` tout en ne persistant qu’une partie du tableau. Le titre de l’epic présente le même défaut de validation.
- **Recommendation:** Appliquer une validation trim/non-vide dans le schéma, supprimer le filtre destructif, retourner `400` si un élément est invalide et tester qu’aucun insert n’a lieu.

## Évaluation du checklist

1. **Readability:** No issues found.
2. **DRY Principle:** Finding 1 — la mutualisation du pipeline d’upload demandée n’existe pas.
3. **Error Handling:** Findings 1 et 5.
4. **Performance:** No issues found.
5. **Naming Conventions:** No issues found.
6. **Type Safety:** Finding 3.
7. **Testing:** Finding 4.
8. **API Design:** Finding 5.

## Vérification

- `git diff --check` : réussi.
- `tsc --noEmit --incremental false` : réussi.
- ESLint des nouveaux fichiers, du layout et des tests : réussi.
- Le lint incluant `page.tsx` retrouve ses diagnostics `set-state-in-effect`.
- Vitest n’a pas pu démarrer : le sandbox en lecture seule interdit la création de son répertoire temporaire.
- Le dépôt structuré des findings auprès d’Arij a été tenté, mais refusé par la politique d’approbation `never`.

**Summary:** 0 Critical, 5 Major, 0 Minor, 0 Suggestions.

**Overall Verdict: Changes Requested**