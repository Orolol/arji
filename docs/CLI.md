# **Architectures et Protocoles d'Intégration Programmatique des Interfaces de Ligne de Commande (CLI) pour les Modèles de Langage en Mode Headless**

L'évolution contemporaine du développement logiciel assisté par intelligence artificielle a franchi une étape décisive avec l'émergence des agents autonomes opérant au sein du terminal. Cette mutation technologique s'accompagne d'un besoin croissant pour les ingénieurs de disposer d'outils capables de s'intégrer de manière fluide dans des pipelines d'automatisation, des scripts système et des environnements de déploiement continu. Le concept de mode « headless », ou mode sans interface, permet d'invoquer la puissance de raisonnement des modèles de langage (LLM) comme une primitive logicielle programmable, respectant ainsi la philosophie Unix de composition d'outils modulaires.1 Ce rapport détaille les spécifications techniques, les arguments de commande et les mécanismes de gestion de session des principales interfaces de ligne de commande, en mettant l'accent sur leur utilisation programmatique et leur extensibilité via des protocoles standardisés.

## **Fondamentaux de l'Automatisation via les CLI LLM**

Le passage d'une interaction conversationnelle classique à une exécution programmatique nécessite une compréhension rigoureuse des structures d'arguments fournies par les développeurs de ces outils. Un agent opérant en mode headless doit être capable de recevoir des instructions via l'entrée standard (stdin) ou des arguments de ligne de commande, d'exécuter des tâches complexes impliquant la lecture ou l'édition de fichiers, et de retourner un résultat structuré, généralement au format JSON, pour permettre un traitement ultérieur par d'autres utilitaires.2  
Cette approche permet de transformer l'IA d'un simple assistant de discussion en un moteur d'exécution capable de réaliser des revues de code automatiques, de générer de la documentation technique ou de résoudre des conflits de fusion de manière autonome.4 La standardisation de ces interactions repose de plus en plus sur des protocoles tels que le Model Context Protocol (MCP) et l'Agent Client Protocol (ACP), qui fournissent une couche d'abstraction entre le modèle de langage et les outils locaux ou distants qu'il peut invoquer.4

## **Claude Code : L'Approche SDK et l'Intégration Native**

Développé par Anthropic, Claude Code se positionne comme un agent de codage de terminal capable de gérer des contextes de projet complexes. Son mode headless, officiellement intégré via le SDK de l'agent, permet une exécution non interactive rigoureuse.2 Le drapeau principal pour activer ce mode est \-p (ou \--print), qui signale au système de traiter la requête et de quitter immédiatement après la production de la réponse.2

### **Arguments de Commande et Contrôle Programmatique**

L'utilisation de Claude Code dans des scripts nécessite une gestion précise des permissions et des formats de sortie. Le tableau suivant récapitule les arguments essentiels pour une intégration headless réussie.

| Argument | Fonction | Application Programmatique |
| :---- | :---- | :---- |
| \-p, \--print | Exécute la requête de manière non interactive. | Déclenchement d'actions uniques dans des scripts Bash ou Python.2 |
| \--output-format | Définit le format de la réponse (text, json, stream-json). | Extraction de données structurées via jq.9 |
| \--allowedTools | Spécifie les outils autorisés sans confirmation humaine. | Automatisation sécurisée de Bash, Read, Edit.2 |
| \--continue, \-c | Reprend la conversation la plus récente. | Enchaînement d'instructions dépendantes du contexte précédent.2 |
| \--resume | Charge une session spécifique via son identifiant. | Gestion de fils de discussion parallèles dans des serveurs d'automatisation.2 |
| \--json-schema | Impose un schéma strict à la sortie JSON. | Garantit la conformité des données pour les processus en aval.2 |
| \--dangerously-skip-permissions | Désactive toutes les demandes de confirmation. | Utilisation impérative dans des conteneurs CI isolés.8 |

L'argument \--output-format json est crucial pour les développeurs, car il encapsule non seulement la réponse textuelle du modèle, mais aussi l'identifiant de la session (session\_id), les statistiques de jetons et les métadonnées de coût.2 Cela permet d'extraire dynamiquement le session\_id pour le réutiliser dans une commande ultérieure avec le flag \--resume, assurant ainsi la continuité du raisonnement à travers plusieurs appels distincts au binaire.2

### **Gestion du Contexte et Résumé de Session**

Claude Code utilise un fichier de configuration nommé CLAUDE.md situé à la racine du projet. Ce document sert de mémoire persistante, contenant des directives architecturales et des standards de codage que l'agent consulte à chaque initialisation de session.4 Pour générer un résumé de projet ou de session de manière programmatique, l'utilisateur peut invoquer la commande : claude \-p "Générer un résumé des changements effectués" \--continue \--output-format json | jq \-r '.result'.2 L'utilisation de \--continue garantit que le résumé porte sur les interactions précédentes au sein du même répertoire de travail.2

### **Manipulation de Contenus Multimédias**

Bien que Claude Code soit principalement orienté vers le texte et le code source, il supporte l'inclusion d'images pour des tâches de conception ou de débogage visuel. En mode headless, l'inclusion d'une image se fait en fournissant le chemin d'accès au fichier directement dans la chaîne de caractères du prompt.13 Pour que l'agent puisse traiter le fichier sans interruption, il est nécessaire d'activer l'outil de lecture via \--allowedTools Read et, dans un environnement automatisé, d'ajouter \--dangerously-skip-permissions pour éviter tout blocage lié à l'accès au système de fichiers.11

## **Gemini CLI : Flexibilité et Flux de Données JSON**

L'interface de ligne de commande Gemini de Google est conçue comme un agent agile facilitant l'accès direct aux modèles de la famille Gemini Pro et Flash.15 Elle se distingue par une intégration native forte avec les serveurs MCP et une gestion granulaire des flux de données en temps réel.3

### **Architecture Headless et Flux Événementiels**

Le mode headless de Gemini CLI est activé par le flag \--prompt ou \-p. Une caractéristique avancée de cet outil est sa capacité à émettre des flux JSON détaillés qui permettent de suivre l'évolution interne de l'agent.3

| Option de Configuration | Description Technique | Exemple d'Usage Headless |
| :---- | :---- | :---- |
| \--output-format stream-json | Émet des événements JSON par ligne (LJSON). | Surveillance en temps réel des appels d'outils.3 |
| \--yolo, \-y | Mode d'approbation automatique totale. | Exécution de scripts de refactorisation massive.17 |
| \--include-directories | Ajoute des répertoires externes au contexte. | Analyse de dépendances entre plusieurs dépôts.15 |
| \--model, \-m | Sélection spécifique du moteur (Flash vs Pro). | Optimisation de la latence pour les tâches simples.15 |
| \--approval-mode | Définit le niveau de confiance (auto\_edit, yolo). | Contrôle fin des permissions d'écriture.17 |

L'utilisation du format stream-json est particulièrement riche d'enseignements pour l'intégration programmatique. Le CLI émet différents types d'événements : init (démarrage de session), tool\_use (appel d'une fonction externe), tool\_result (résultat de la fonction) et result (réponse finale avec statistiques).3 Cette structure permet à un script parent de réagir dynamiquement, par exemple en interrompant l'exécution si l'agent tente d'utiliser un outil non autorisé ou si le coût estimé dépasse un certain seuil.3

### **Mécanismes de Persistance et Compression**

Gemini CLI enregistre automatiquement chaque interaction dans une base de données locale située dans \~/.gemini/tmp/.19 Cette architecture projet-dépendante assure que le changement de répertoire entraîne automatiquement le changement de contexte de session.20 Programmatique, la commande /compress peut être envoyée pour forcer l'agent à synthétiser l'historique actuel, remplaçant ainsi le contexte volumineux par un résumé dense afin d'économiser des jetons lors des étapes suivantes d'un workflow automatisé.3 La reprise d'une session spécifique s'effectue via gemini \--resume \<index\_ou\_UUID\>, ce qui facilite l'orchestration de tâches longues sur plusieurs jours.17

### **Capacités Multimodales Programmatiques**

Pour inclure des images dans une analyse via Gemini CLI en mode headless, l'approche recommandée consiste à placer les fichiers visuels dans un répertoire surveillé et à utiliser l'argument \--include-directories.3 L'agent est alors capable de corréler des captures d'écran de crashs d'application avec les logs textuels fournis par stdin.22 Le mode YOLO est ici indispensable pour que le changement de modèle vers une variante vision-capable s'opère sans intervention manuelle.14

## **Mistral Vibe : Orchestration par Profils d'Agents**

Mistral Vibe représente une itération moderne des CLI de codage, s'appuyant sur les modèles Devstral pour offrir une fiabilité accrue dans l'orchestration d'outils.5 Il introduit une séparation claire entre les capacités de planification et d'exécution.6

### **Profils d'Agents et Programmation par Contraintes**

L'un des apports majeurs de Vibe est l'utilisation de profils d'agents prédéfinis, ce qui simplifie la configuration des permissions pour les environnements headless.24

| Profil d'Agent | Comportement et Outils | Contexte Programmatique |
| :---- | :---- | :---- |
| plan | Lecture seule, outils de recherche actifs. | Exploration de codebase et audit de sécurité.24 |
| accept-edits | Auto-approbation des modifications de fichiers. | Refactorisation de code et correction de lint.24 |
| auto-approve | Autonomie totale sur tous les outils. | Pipeline CI/CD sans surveillance humaine.24 |
| default | Approbation manuelle requise par défaut. | Non recommandé pour le mode headless strict.24 |

En invoquant vibe \--prompt "votre requête" \--agent auto-approve, le développeur délègue l'intégralité du contrôle à l'agent.24 Pour limiter les risques de boucles infinies ou de consommation excessive de ressources, Vibe propose les arguments \--max-turns et \--max-price, permettant de définir un budget strict en nombre d'interactions ou en dollars US pour chaque exécution headless.24

### **Systèmes de Skills et Résumés JSON**

Vibe permet l'extension de ses capacités via un système de "Skills", défini par des fichiers Markdown (SKILL.md) contenant des métadonnées YAML.24 Ces compétences peuvent être invoquées de manière programmatique pour structurer des workflows répétitifs. En ce qui concerne la synthèse, l'argument \--output json produit une sortie finale contenant l'intégralité de la conversation et les métadonnées de performance, facilitant ainsi la création automatique de journaux de bord ou de résumés de session via des outils de traitement de texte externes.24

## **Qwen Code : Puissance de Raisonnement et Vision Intégrée**

Dérivé de l'écosystème Alibaba, Qwen Code CLI exploite les modèles Qwen3-Coder pour offrir des fenêtres de contexte massives (jusqu'à 1 million de jetons), idéales pour l'analyse de dépôts de code complets en une seule invocation.26

### **Commandes et Authentification en Environnement Contraint**

Qwen Code supporte le mode headless via l'argument \-p, mais se distingue par sa gestion de l'authentification dans des environnements sans interface graphique comme les serveurs SSH ou les conteneurs Docker.28 Contrairement au flux OAuth standard, il permet l'utilisation d'une clé API directe pour les exécutions automatisées.28

| Commande / Argument | Fonctionnalité | Intérêt Programmatique |
| :---- | :---- | :---- |
| qwen \-p "requête" \--yolo | Exécution autonome immédiate. | Scripting rapide pour des tâches de maintenance.28 |
| /stats | Affiche les statistiques de la session. | Surveillance de la consommation de jetons en temps réel.28 |
| /compress | Compresse l'historique de discussion. | Optimisation des performances sur les sessions longues.28 |
| /summary | Produit un résumé du projet. | Génération automatique de README ou de changelogs.28 |
| \--model | Spécifie le modèle (jusqu'à 480B paramètres). | Ajustement du rapport coût/performance.22 |

### **Automatisation Multimodale Native**

Une force majeure de Qwen Code réside dans son mode YOLO (--yolo), qui active le "vision switching" automatique.28 Si le contexte d'entrée contient des références à des images, l'agent bascule de lui-même vers un modèle de vision sans nécessiter de configuration supplémentaire.28 Cette fonctionnalité est particulièrement prisée pour les pipelines de tests front-end où l'agent peut comparer une capture d'écran de l'interface utilisateur avec les spécifications de design fournies en entrée.22

## **OpenCode : Orchestration Multi-Fournisseurs et Extensibilité**

OpenCode se présente comme une alternative ouverte et flexible, supportant plus de 75 fournisseurs de modèles, y compris des instances locales via Ollama et des abonnements commerciaux tels que GitHub Copilot.31 Sa conception en Go en fait un outil performant et facilement distribuable.

### **Interface de Programmation et Mode Serveur**

L'originalité d'OpenCode réside dans sa dualité d'utilisation : il peut fonctionner comme une commande unitaire ou comme un serveur persistant.32

1. **Exécution unitaire** : opencode run "explication du code" permet une interaction rapide et headless.32  
2. **Mode Serveur** : opencode serve lance un serveur HTTP exposant les fonctionnalités de l'agent via une API, ce qui permet à d'autres applications de se connecter à un moteur de raisonnement déjà initialisé, évitant ainsi les délais de démarrage à chaque appel.32  
3. **Arguments programmatiques** : L'argument \--file (ou \-f) permet d'attacher des fichiers spécifiques au prompt, tandis que \--format json garantit que les événements générés par l'agent sont retournés sous forme brute pour une analyse automatisée.32

### **Commandes Personnalisées et Injection Shell**

OpenCode permet aux développeurs de définir des commandes personnalisées via des fichiers JSON ou Markdown.33 Ces commandes peuvent inclure des placeholders d'arguments ($ARGUMENTS, $1, $2) et, plus impressionnant encore, des sorties de commandes shell directes (\! git log) injectées directement dans le prompt.33 Cette capacité transforme le CLI en un orchestrateur puissant capable de raisonner sur l'état dynamique du système avant de formuler une réponse.

## **L'Écosystème Chinois : Moonshot (Kimi) et Zai (Zhipu AI)**

Les modèles de langage développés en Chine, tels que ceux de Moonshot AI et Zhipu AI, ont rapidement adopté des interfaces CLI robustes, souvent compatibles avec les protocoles standard comme OpenAI API, facilitant leur intégration dans les outils occidentaux.34

### **Moonshot AI : Kimi Code CLI et l'Architecture KimiSoul**

Le Kimi Code CLI est un agent sophistiqué qui utilise le protocole ACP pour s'intégrer nativement dans des éditeurs comme Zed.7 Son architecture repose sur "KimiSoul", un moteur d'exécution capable de déléguer des tâches à des sous-agents spécialisés via un "Labor Market".6  
Pour un usage headless, Kimi propose :

* kimi \--print \-c "votre commande" : Exécute une tâche basée sur le contexte le plus récent.6  
* /init : Crée un fichier AGENTS.md pour définir les conventions du projet, similaire au CLAUDE.md d'Anthropic.37  
* **Outils Officiels** : Le CLI peut invoquer des outils tels que web-search, excel (analyse de fichiers CSV) et code\_runner (exécution de code Python en environnement sécurisé).38

### **Zai (Zhipu AI) : GLM et le Raisonnement Hybride**

Zai, anciennement Zhipu AI, propose la série GLM-4.5 qui intègre un mode de raisonnement hybride.36 L'agent peut basculer entre un "Thinking Mode" (pour la résolution de problèmes complexes et l'utilisation d'outils) et un "Non-Thinking Mode" (pour les réponses rapides et directes).36 Programmatique, Zai est accessible via des bibliothèques comme LiteLLM en configurant l'identifiant de modèle zai/glm-4.7 et en utilisant la clé API obtenue sur leur portail international.39

## **DeepSeek et Codex : Performance de Spécialisation**

DeepSeek et les variantes de Codex représentent des outils hautement spécialisés, l'un pour l'efficacité des jetons et l'autre pour la vitesse pure d'inférence.

### **DeepSeek CLI : Optimisation du Cache et du Contexte**

Le CLI DeepSeek met l'accent sur la réduction des coûts opérationnels grâce à une gestion agressive du cache de contexte sur disque, permettant des économies allant jusqu'à 90% lors de requêtes répétitives sur les mêmes fichiers de code.40 Les options programmatiques incluent :

* \-q, \--query : Exécution headless.  
* \-m, \--model : Choix entre deepseek-chat, deepseek-coder et deepseek-reasoner (ce dernier affichant la chaîne de pensée CoT avant la réponse).40  
* \--no-stream : Indispensable pour capturer la réponse complète dans une variable de script sans gérer les morceaux de texte asynchrones.40

### **Codex-Spark et vLLM : Inférence Ultra-Rapide**

Le projet Codex-Spark, né de la collaboration entre OpenAI et Cerebras, vise à offrir une vitesse d'inférence dépassant les 1000 jetons par seconde.41 Bien que principalement disponible en "research preview", il s'intègre dans des CLI et des extensions VS Code pour offrir un retour visuel quasi instantané.41 Parallèlement, vLLM permet de servir des modèles comme Baichuan 2 ou Qwen de manière locale avec une efficacité maximale, offrant une compatibilité API OpenAI qui rend n'importe quel CLI standard (comme llm-cli) capable de piloter ces modèles chinois en mode headless local.42

## **Synthèse Technique des Commandes Programmatiques**

Le tableau ci-dessous offre une comparaison exhaustive des capacités headless des principaux CLI, permettant aux ingénieurs de choisir l'outil le plus adapté à leurs besoins d'automatisation.

| CLI | Commande Headless | Format de Sortie | Gestion de Session | Support Multimodal |
| :---- | :---- | :---- | :---- | :---- |
| **Claude Code** | \-p "..." | JSON, Text, Stream | \--resume \<ID\> | Chemin fichier \+ Outil Read.2 |
| **Gemini CLI** | \-p "..." | JSON, Stream-JSON | \--resume \<UUID\> | \--include-directories.3 |
| **Mistral Vibe** | \--prompt "..." | JSON (complet) | \--resume \<ID\> | Skills / MCP.24 |
| **Qwen Code** | \-p "..." | JSON | /resume | Auto-switch YOLO.22 |
| **OpenCode** | run "..." | JSON, Events | \--session \<ID\> | \--file / \-f.32 |
| **DeepSeek** | \-q "..." | Raw, Stream | Historique SQLite | Vision via Chat.40 |
| **Moonshot** | \--print "..." | Stream-JSON | \--continue | Outil fetch / Vision.6 |

### **Stratégies Avancées de Résumé de Session**

Dans un contexte de développement continu, le résumé automatique des sessions permet de générer des rapports de progression sans intervention humaine.

* **Claude et Gemini** privilégient une approche persistante où l'historique est stocké localement et peut être synthétisé par un appel final demandant explicitement un résumé.2  
* **Mistral et Qwen** permettent une extraction programmatique via JSON à la fin de chaque tour, envoyant l'intégralité de l'état de l'agent vers un système de log centralisé pour analyse ultérieure.24

### **Mécanismes d'Inclusion d'Images en Mode Automatisé**

L'intégration d'images dans des flux automatisés varie selon la maturité de l'outil.

* **Approche par chemin** : Claude et Codex exigent que l'image soit référencée par son chemin local, le modèle se chargeant de charger le fichier si les permissions sont accordées.13  
* **Approche par contexte** : Gemini et Qwen incluent les images comme faisant partie du "répertoire de travail", utilisant leur large fenêtre de contexte pour maintenir la conscience visuelle à travers plusieurs interactions.3

## **Conclusion et Perspectives Futures**

L'adoption généralisée du mode headless dans les interfaces de ligne de commande LLM marque la fin de l'ère de l'IA comme simple "compagnon de discussion" pour inaugurer celle de l'IA comme "composant d'infrastructure". La capacité de ces outils à fonctionner sans intervention humaine, à s'auto-attribuer des permissions dans des environnements contrôlés (YOLO) et à interagir avec des protocoles standardisés (MCP/ACP) ouvre la voie à des systèmes logiciels capables de s'auto-maintenir et de s'auto-documenter.  
Le futur de ces technologies réside dans l'interopérabilité croissante entre les fournisseurs de modèles. Comme le montre l'exemple de DeepSeek s'intégrant dans le flux de Claude Code ou de Kimi servant de moteur de raisonnement pour Zed, la frontière entre l'interface utilisateur et le moteur d'intelligence s'efface au profit d'une couche d'orchestration terminale unifiée. Pour les organisations, la maîtrise de ces CLI en mode programmatique est devenue un levier de productivité essentiel, permettant de réduire drastiquement le temps passé sur les tâches de maintenance répétitives pour se concentrer sur l'innovation architecturale.1
