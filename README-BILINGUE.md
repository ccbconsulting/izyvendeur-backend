# IzyVendeur — Choix de langue FR/EN (bot catalogue + interface /admin)

## Étape 1 — Le bot WhatsApp (moteur catalogue)

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

Un petit bug a été trouvé et corrigé pendant les tests : si un client tapait "voir mon panier" (ou
"view my cart") juste au moment où le bot lui demandait son téléphone et son adresse pour finaliser
la commande, le bot ne reconnaissait pas la demande et l'avalait par erreur comme si c'était le début
de l'adresse. Ce n'était pas un problème introduit par le bilingue (ça existait déjà en français avant),
mais c'est maintenant corrigé dans les deux langues.

## Étape 2 — L'interface /admin (nouveau)

L'interface /admin (tableau de bord, catalogue, commandes, rendez-vous, services, conversations,
paramètres, employés, mon compte...) a maintenant un bouton **FR / EN** en haut à droite de l'écran,
à côté du sélecteur de marchand.

- Chacun (vous, un marchand, un employé) choisit sa langue à tout moment en cliquant sur ce bouton —
  ça ne demande aucune configuration. Le choix est mémorisé dans le navigateur, donc il reste d'une
  visite à l'autre sur le même appareil.
- Absolument tout est traduit : les onglets, les titres, les libellés de formulaires, les en-têtes de
  tableaux, les messages d'erreur, les fenêtres de confirmation/saisie (par exemple "Supprimer ce
  marchand ?", création d'un employé, etc.).
- Important : les **données elles-mêmes ne changent jamais de langue**. Un statut de commande
  ("Nouvelle", "Confirmée"...), un jour de la semaine dans les horaires, ou le mode de livraison,
  restent stockés exactement comme avant côté serveur — seul leur **affichage** est traduit selon la
  langue choisie. Vous pouvez donc basculer FR ↔ EN sans jamais rien casser ni perdre.
- Les noms d'articles, de catégories, de services que vous avez saisis restent tels quels (pas de
  traduction automatique de vos propres textes).

J'ai testé cette interface de bout en bout (marchand catalogue et marchand service, super-administrateur
et employé, les deux langues, création réelle d'un compte employé, sauvegarde de paramètres) avec un
navigateur automatisé avant de vous l'envoyer — tout s'affiche et fonctionne correctement dans les deux
langues, sans erreur.

## Ce qui n'est PAS encore fait (volontairement, pour la suite)

- **Le moteur rendez-vous (conversationService.js)** — la prise de RDV par le client sur WhatsApp reste
  entièrement en français pour l'instant (l'interface /admin pour gérer les rendez-vous/services, elle,
  est déjà bilingue depuis l'étape 2 ci-dessus). Ce sera la prochaine étape si vous le souhaitez.
- **Les noms d'articles/catégories/services** — un article s'appelle comme vous l'avez écrit
  (ex: "Robe wax imprimée"), il n'y a pas de traduction automatique du nom lui-même.
- Les messages que le bot vous envoie à VOUS, marchand, pour vous notifier d'une nouvelle commande
  restent en français — c'est votre langue, pas celle du client, donc pas concerné.

## Fichiers modifiés dans ce zip

- `conversation.js` — moteur catalogue, logique de choix de langue + traduction de toutes les réponses
- `shared.js` — fonctions de gestion de langue partagées (utilisées aussi plus tard par le moteur RDV)
- `catalog.js` — message de confirmation par défaut en anglais
- `server.js` — petit ajustement pour reconnaître le message de mise en relation dans les 2 langues
- `public/admin.html` — interface /admin entièrement bilingue (bouton FR/EN)

## Comment déployer

1. Remplacez les 5 fichiers ci-dessus dans votre dépôt par ceux de ce zip (mêmes emplacements).
2. `git add -A && git commit -m "Choix de langue FR/EN pour le bot catalogue et l'interface /admin"`
3. `git push`
4. Render redéploie automatiquement (ou lancez un "Manual Deploy" depuis le tableau de bord Render
   si l'auto-deploy n'est pas activé).

Testez ensuite en envoyant "hello" ou "hi" à votre numéro WhatsApp bot (message de bienvenue bilingue),
et en ouvrant /admin pour essayer le bouton FR/EN en haut de l'écran.
