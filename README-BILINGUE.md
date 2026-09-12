# IzyVendeur — Choix de langue FR/EN pour le moteur catalogue

## Ce qui est fait maintenant

Le bot WhatsApp (moteur "catalogue" — boutique en ligne, PAS le moteur rendez-vous) parle maintenant
français OU anglais, au choix du client.

Comment ça marche pour le client :
1. Premier message reçu d'un nouveau numéro → le bot répond d'abord avec un message bilingue :
   "Bienvenue 👋 / Welcome! Répondez FR pour continuer en français. Reply EN to continue in English."
2. Le client répond FR ou EN (ou même juste "english", "french", etc.) → toute la conversation
   qui suit est dans cette langue.
3. À tout moment, le client peut changer d'avis en tapant des phrases comme "in english please",
   "en français", "switch to english" → le bot bascule immédiatement et confirme
   ("Sure, I'll continue in English. 🇬🇧" / "Très bien, je continue en français. 🇫🇷").
4. La langue reste mémorisée pour tout le reste de la conversation (même après une commande finalisée,
   même si le client recommence un nouvel achat juste après).

Ce qui est traduit : absolument tout ce que le bot dit lui-même au client — présentation des articles,
choix couleur/taille, disponibilité, panier, mode de livraison (retrait/livraison), demande d'adresse
et de téléphone, récapitulatif de commande, message de confirmation final, mise en relation avec un
humain, etc. Le bot reconnaît aussi les mots-clés anglais ("cart", "view my cart", "talk to a human",
"pickup", "delivery"...) exactement comme les mots-clés français.

Le message de confirmation automatique que VOUS personnalisez dans /admin (Paramètres > Catalogue)
a maintenant un deuxième champ optionnel "Message de confirmation — English". Si vous le laissez vide,
le client anglophone reçoit un message de confirmation par défaut déjà traduit — il ne verra jamais
votre texte français par erreur.

## Correctif ajouté (v2)

Un petit bug a été trouvé et corrigé pendant les tests : si un client tapait "voir mon panier" (ou
"view my cart") juste au moment où le bot lui demandait son téléphone et son adresse pour finaliser
la commande, le bot ne reconnaissait pas la demande et l'avalait par erreur comme si c'était le début
de l'adresse. Ce n'était pas un problème introduit par le bilingue (ça existait déjà en français avant),
mais c'est maintenant corrigé dans les deux langues : à cette étape précise, le bot affiche le panier
puis rappelle ce qu'il manque encore (téléphone et/ou adresse), sans rien perdre de ce qui a déjà été
donné.

## Ce qui n'est PAS encore fait (volontairement, pour la suite)

- **Le moteur rendez-vous (conversationService.js)** — la prise de RDV reste entièrement en français
  pour l'instant. Ce sera la prochaine étape si vous le souhaitez.
- **L'interface /admin elle-même** — les menus, boutons, écrans du tableau de bord restent en français
  (seul le nouveau champ "message de confirmation anglais" a été ajouté). Traduire tout /admin serait
  une 3ème étape séparée.
- **Les noms d'articles/catégories/services** — un article s'appelle comme vous l'avez écrit
  (ex: "Robe wax imprimée"), il n'y a pas de traduction automatique du nom lui-même. Seules les phrases
  du bot autour de ce nom sont bilingues.
- Les messages que le bot vous envoie à VOUS, marchand, pour vous notifier d'une nouvelle commande
  restent en français — c'est votre langue, pas celle du client, donc pas concerné.

## Fichiers modifiés dans ce zip

- `conversation.js` — moteur catalogue, logique de choix de langue + traduction de toutes les réponses
- `shared.js` — nouvelles fonctions de gestion de langue partagées (utilisées aussi plus tard par le moteur RDV)
- `catalog.js` — message de confirmation par défaut en anglais
- `server.js` — petit ajustement pour reconnaître le message de mise en relation dans les 2 langues
- `public/admin.html` — nouveau champ "Message de confirmation — English" dans Paramètres > Catalogue

## Comment déployer

1. Remplacez les 5 fichiers ci-dessus dans votre dépôt par ceux de ce zip (mêmes emplacements).
2. `git add -A && git commit -m "Ajout du choix de langue FR/EN pour le bot catalogue"`
3. `git push`
4. Render redéploie automatiquement (ou lancez un "Manual Deploy" depuis le tableau de bord Render
   si l'auto-deploy n'est pas activé).

Testez ensuite en envoyant "hello" ou "hi" à votre numéro WhatsApp bot — vous devriez recevoir le
message de bienvenue bilingue.
