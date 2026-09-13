# IzyVendeur — Choix de langue FR/EN (bot catalogue + interface /admin)

## Étape 1 — Le bot WhatsApp (moteur catalogue)

Le bot WhatsApp (moteur "catalogue" — boutique en ligne, PAS le moteur rendez-vous) parle maintenant
français OU anglais, au choix du client.

Comment ça marche pour le client :
1. Premier message reçu d'un nouveau numéro → le bot répond avec un message bilingue :
   "Bienvenue 👋 / Welcome! Répondez FR pour continuer en français. Reply EN to continue in English." —
   accompagné d'un **menu déroulant tactile** ("Choisir / Choose" → Français / English) pour que le
   client puisse choisir sans rien taper, en plus de pouvoir répondre FR/EN au clavier s'il préfère.
2. Le client choisit dans le menu (ou tape FR/EN, ou même juste "english", "french", etc.) → toute la
   conversation qui suit est dans cette langue.
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

Un deuxième oubli a été trouvé et corrigé : les menus tactiles (les listes et boutons cliquables
WhatsApp eux-mêmes — "Voir les articles", "Parler à un conseiller", "Retirer", "Continuer mes achats",
"Terminer ma commande", "Oui"/"Non", etc.) restaient tous affichés en français même quand le client
avait choisi l'anglais, alors que le TEXTE du bot autour d'eux était bien traduit. C'est maintenant
corrigé partout : tous les titres et libellés de menus cliquables suivent la langue choisie par le
client, à chaque étape de la conversation (choix d'article, couleur, taille, quantité, panier,
confirmation finale...). Comme pour le reste, seul l'AFFICHAGE change — les valeurs internes ne
bougent pas.

À noter (ce n'est pas un bug) : les noms d'articles et les noms de couleurs que vous avez saisis dans
votre catalogue (ex: "Rouge", "Robe wax imprimée") ne sont pas traduits automatiquement, exactement
comme indiqué plus bas dans "Ce qui n'est PAS encore fait" — un client anglophone doit donc taper ou
choisir "Rouge" (et non "red") dans la liste, puisque c'est le nom exact que vous avez enregistré.

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

## Étape 3 — Tableau de bord : sélecteur de période (nouveau, hors sujet bilingue)

Ajout indépendant du bilingue, livré dans le même zip pour ne pas multiplier les livraisons pendant
que rien n'est encore déployé chez vous.

- L'onglet **Tableau de bord** (marchand catalogue ET marchand service) a maintenant un sélecteur de
  période juste sous le titre : **Jour / Semaine / Mois / Trimestre / Année**. Les chiffres "Commandes"
  et "Chiffre d'affaires" (ou "Rendez-vous pris" côté service) se recalculent instantanément selon la
  période choisie, avec la plage de dates affichée juste à côté (ex: "01/09/2026 – 30/09/2026"). Par
  défaut, la période est "Jour" (comme avant), donc rien ne change pour qui n'y touche pas.
- La tendance "Activité des 7 derniers jours" (le petit graphique en barres) et les indicateurs "à
  surveiller maintenant" (stock bas/ruptures, prochains rendez-vous) restent volontairement **toujours
  sur leur propre fenêtre habituelle**, indépendamment de la période choisie dans le sélecteur — ce sont
  des indicateurs de "pouls immédiat"/"à venir", pas des cumuls historiques, donc ça n'aurait pas de sens
  de les faire varier avec un sélecteur "Trimestre" par exemple.
- Le classement "Articles les plus vendus" / "Services les plus demandés" suit maintenant, lui, la
  période choisie (avant, il montrait toujours le cumul depuis le tout début — c'est plus précis
  maintenant, mais notez ce changement de comportement).
- L'onglet **Rapports** (marchand catalogue) avait déjà un sélecteur mais limité à Jour/Semaine/Mois —
  **Trimestre et Année** sont maintenant disponibles là aussi, pour rester cohérent avec le Tableau de
  bord.

J'ai testé les deux onglets avec un navigateur automatisé (les deux langues, plusieurs périodes, avec
une vraie commande passée pour vérifier que les chiffres bougent correctement) avant de vous l'envoyer.

## Étape 4 — Message d'accueil personnalisé (nouveau, hors sujet bilingue)

Autre ajout indépendant, livré dans le même zip.

- Nouveau réglage dans l'onglet **Paramètres** (marchand catalogue uniquement) : **"Message d'accueil
  personnalisé"**, en français et en anglais, facultatif, vide par défaut (rien ne change tant que vous
  ne le remplissez pas).
- Quand il est rempli, ce texte s'affiche **une seule fois**, juste avant le message de bienvenue
  bilingue et le menu de choix de langue, au tout premier message d'un nouveau contact — les deux
  langues (si vous remplissez les deux champs) sont affichées ensemble, séparées par une ligne vide,
  dans la même bulle WhatsApp que le message de bienvenue.
- Pensé au départ pour votre marchand de test/démonstration : vous pouvez y écrire par exemple "Ceci
  est la plateforme de démonstration IzyVendeur, sentez-vous libre de la tester, pour obtenir le
  service contactez le [votre numéro]" — mais n'importe quel marchand peut s'en servir pour sa propre
  intro personnalisée.
- Restez concis : ce texte partage la même bulle WhatsApp (et donc la même limite de longueur) que le
  message de bienvenue et le menu de langue — quelques phrases suffisent.

Testé de bout en bout (sans réglage = comportement inchangé, avec réglage = message affiché
correctement et menu de langue toujours cliquable, sauvegarde/rechargement dans /admin, les deux
langues de l'interface) avant livraison.

## Ce qui n'est PAS encore fait (volontairement, pour la suite)

- **Le moteur rendez-vous (conversationService.js)** — la prise de RDV par le client sur WhatsApp reste
  entièrement en français pour l'instant (l'interface /admin pour gérer les rendez-vous/services, elle,
  est déjà bilingue depuis l'étape 2 ci-dessus). Ce sera la prochaine étape si vous le souhaitez.
- **Les noms d'articles/catégories/services** — un article s'appelle comme vous l'avez écrit
  (ex: "Robe wax imprimée"), il n'y a pas de traduction automatique du nom lui-même.
- Les messages que le bot vous envoie à VOUS, marchand, pour vous notifier d'une nouvelle commande
  restent en français — c'est votre langue, pas celle du client, donc pas concerné.

## Fichiers modifiés dans ce zip

- `conversation.js` — moteur catalogue : logique de choix de langue + traduction de toutes les réponses,
  et calcul du Tableau de bord/Rapports par période (jour/semaine/mois/trimestre/année)
- `conversationService.js` — moteur rendez-vous : reste en français (voir plus bas), mais reçoit la même
  logique de calcul du Tableau de bord par période que le moteur catalogue
- `shared.js` — fonctions de gestion de langue partagées (utilisées aussi plus tard par le moteur RDV)
- `catalog.js` — message de confirmation par défaut en anglais
- `server.js` — reconnaissance du message de mise en relation dans les 2 langues + **menu déroulant
  tactile Français/English** pour la porte de langue (au lieu de devoir taper FR/EN), sur le même
  principe que les autres menus cliquables déjà présents dans le bot (choix d'article, couleur, taille...)
  + traduction de TOUS les menus tactiles eux-mêmes (titres de listes/boutons) selon la langue du client
  + la route du Tableau de bord accepte maintenant un paramètre de période
- `public/admin.html` — interface /admin entièrement bilingue (bouton FR/EN) + sélecteur de période sur
  le Tableau de bord + Trimestre/Année ajoutés à l'onglet Rapports + nouveau champ "Message d'accueil
  personnalisé" dans l'onglet Paramètres

## Comment déployer

1. Remplacez les 6 fichiers ci-dessus dans votre dépôt par ceux de ce zip (mêmes emplacements).
2. `git add -A && git commit -m "Choix de langue FR/EN + sélecteur de période sur le Tableau de bord"`
3. `git push`
4. Render redéploie automatiquement (ou lancez un "Manual Deploy" depuis le tableau de bord Render
   si l'auto-deploy n'est pas activé).

Testez ensuite en envoyant "hello" ou "hi" à votre numéro WhatsApp bot (message de bienvenue bilingue),
et en ouvrant /admin pour essayer le bouton FR/EN en haut de l'écran.
