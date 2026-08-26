**Code Review**

# Rapport de revue

Périmètre examiné : commits `fc7d2ec` et `57c25e9`, ainsi que les routes, composants de détail, prompts agent et tests associés à l’ensemble de l’epic.

## Findings

### 1. Création de bug sans prise en charge des images

- **Severity:** Major
- **Location:** [components/kanban/BugCreateDialog.tsx:58](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/components/kanban/BugCreateDialog.tsx:58)
- **Description:** La modale envoie uniquement `title`, `description` et `priority`. Aucun upload, paste, drag & drop, aperçu, suppression ou message de validation MIME/taille n’est implémenté. Le champ backend `images` ne peut donc jamais être alimenté depuis l’UI.
- **Recommendation:** Extraire le pipeline du chat dans un hook/composant partagé, l’intégrer à la modale et transmettre les références normalisées dans le POST de création.

### 2. Images persistées jamais affichées dans le ticket

- **Severity:** Major
- **Location:** [components/kanban/EpicDetail.tsx:430](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/components/kanban/EpicDetail.tsx:430)
- **Description:** `useEpicDetail` récupère `epic.images`, mais le détail du ticket ne lit ni n’affiche ce champ. Même un bug créé directement via l’API avec des images ne présente aucune miniature ou vue agrandie.
- **Recommendation:** Ajouter un normaliseur JSON tolérant `null` et les anciennes données, puis afficher des miniatures accessibles avec ouverture en grand.

### 3. Captures absentes des prompts agent

- **Severity:** Major
- **Location:** [lib/claude/prompt-builder.ts:56](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/lib/claude/prompt-builder.ts:56)
- **Description:** `PromptEpic` et `TeamEpic` ne représentent pas les images. Les builders de build, team build et review n’émettent donc aucun chemin local. Send to Dev, Create And Fix, les pipelines et les reviews ignorent tous les captures, quel que soit le provider.
- **Recommendation:** Introduire une section partagée de pièces jointes dans les prompts, étendre les types concernés et couvrir build/review/team avec et sans image.

### 4. Couverture E2E et normalisation des pièces jointes absentes

- **Severity:** Major
- **Location:** [e2e/home.spec.ts:3](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/e2e/home.spec.ts:3)
- **Description:** La suite Playwright ne contient que trois tests smoke du dashboard. Les deux scénarios demandés — epic manuelle avec deux stories et bug avec image collée — n’existent pas. Aucun test unitaire ne couvre le filtrage MIME/taille ou la normalisation des pièces jointes.
- **Recommendation:** Ajouter les deux parcours Playwright ainsi que des tests Vitest sur le filtrage, la persistance/restitution et l’injection dans les prompts.

### 5. L’API supprime silencieusement les stories invalides

- **Severity:** Major
- **Location:** [app/api/projects/[projectId]/epics/route.ts:207](/home/orosius/workspace/.arij-worktrees/feature-epic-noiu4l-H9CkZ-cr-ation-directe-d-epic-depuis-le-bouton/app/api/projects/[projectId]/epics/route.ts:207)
- **Description:** Le schéma accepte un titre composé uniquement d’espaces, puis ce filtre retire silencieusement la story avant la transaction. Une requête avec une story valide et une story `"   "` retourne donc `201` en ne persistant qu’une partie du tableau, contrairement au contrat atomique.
- **Recommendation:** Appliquer `trim()`/`refine()` dans le schéma aux titres de l’epic et des stories, rejeter toute la requête en `400`, retirer le filtre destructif et tester l’absence totale d’insertions.

## Évaluation du checklist

1. **Readability:** No issues found. Le formulaire manuel et son helper pur sont lisibles et correctement structurés.
2. **DRY Principle:** La partie manuelle est correctement factorisée. Le pipeline partagé requis pour les images reste absent — voir finding 1.
3. **Error Handling:** Findings 1 et 5. Les erreurs d’upload ne peuvent pas être présentées et l’API perd silencieusement des stories invalides.
4. **Performance:** No issues found.
5. **Naming Conventions:** No issues found. Les conventions existantes PascalCase/camelCase sont respectées.
6. **Type Safety:** Finding 3. Les types de prompt omettent entièrement les images.
7. **Testing:** Finding 4. Les tests unitaires du formulaire manuel sont solides, mais la couverture demandée pour l’epic complète manque.
8. **API Design:** Finding 5. La route transactionnelle existe, mais son comportement de filtrage produit une réussite partielle.

## Vérification

- `tsc --noEmit --incremental false` : réussi.
- ESLint ciblé : réussi.
- Tests ciblés : **64/64 réussis**.
- Suite complète : **3356 réussis, 18 échoués, 27 ignorés**. Les échecs observés proviennent des restrictions du sandbox (`spawnSync EPERM`, écoute localhost interdite et `process.chdir` indisponible), pas des fichiers modifiés.
- Aucun des deux scénarios Playwright requis n’existe.

La création manuelle d’epic est correctement implémentée, y compris la transaction et le menu accessible. En revanche, quatre user stories sur les images/tests ne sont pas livrées. La soumission structurée des findings à Arij a été tentée, mais refusée par la politique d’approbation `never` de cette session.

**Summary:** 0 Critical, 5 Major, 0 Minor, 0 Suggestions.

**Overall Verdict: Changes Requested**