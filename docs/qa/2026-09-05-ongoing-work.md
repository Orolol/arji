# Finalisation des deux chantiers en cours — 5 septembre 2026

Intégration des branches `nAEgNaSBXba1` (couverture ciblée) et `uZmkGkt1ougt`
(finitions Piscine), y compris le dernier test de dispatch `db82e12`.

## Résultat

- Now est une destination centrée ; les chips projets restent hors de l’îlot.
- Les contrôles Piscine utilisent le curseur attendu.
- Your turn se replie à vide, défile à six lignes et mesure son débordement.
- Un signal écarté reste masqué après rechargement ; un nouvel échec réapparaît.
- Les contrôles Git sont sur Git Sync, les vagues et night runs sur Working.
- Les agents Full Auto se règlent globalement et par projet ; le dispatch réel
  respecte le choix et sa priorité.
- Les tests de fichiers servis couvrent les chemins interdits et les symlinks.
- Les parcours navigateur utilisent le registre et l’overlay actuels pour les
  statuts, le build, la revue et le merge.

Les critères historiques de glisser-déposer ont été adaptés au produit actuel,
qui n’a plus de colonnes manipulables. La migration des dismissals porte le
numéro 0050, après les deux migrations MCP de main, au lieu du 0048 initial.

## Vérification

- Installation cohérente avec le lockfile, vérifiée par le test dédié.
- Vitest : **541 fichiers, 7 373 tests réussis**.
- Chrome, serveur de production isolé : **15 parcours × 3 = 45 réussites**.
- Build de production et TypeScript : réussis.
- ESLint sur main : **0 erreur**, 25 avertissements restants. Les worktrees
  historiques, clones et données sont exclus comme dans la configuration Vitest.
- Migration appliquée à une copie cohérente de la base personnelle : 49 → 50,
  tickets conservés, `quick_check = ok`.
- Captures navigateur inspectées : six échecs sur le desk et huit projets
  dans la navigation. Les assertions couvrent aussi 0/1 ligne et deux hauteurs.

Les parcours d’agents remplacent uniquement les CLIs externes par des scripts :
dispatch, sessions, worktrees, MCP, transitions et merges passent par Arij.
La suite utilise désormais `data/e2e.db` et exige un choix explicite pour
réutiliser un serveur existant. Aucun appel à un modèle payant pendant ces tests.

Les trois tests GitHub Issues utilisaient l’ancienne forme du PAT dans leur
fixture ; ils utilisent maintenant la réponse masquée `{ hasToken }` de l’API.
