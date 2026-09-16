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

## Étape 5 — Logo du marchand (nouveau, hors sujet bilingue)

Encore un ajout indépendant, discuté avec vous avant d'être construit.

- Nouveau bloc **"Logo"** dans l'onglet **Mon compte** (visible pour vous en tant que super-administrateur
  quand vous gérez un marchand, et pour un marchand qui gère son propre compte) : upload d'une image
  (JPEG, PNG ou WEBP, 5 Mo max), avec aperçu et bouton pour la supprimer/remplacer.
- Une fois envoyé, ce logo s'affiche :
  1. **Dans /admin** : en haut de l'écran, à côté du titre, pour le marchand actif.
  2. **Dans WhatsApp** : envoyé par le bot en toute première image, avant même le message de bienvenue
     bilingue, au tout premier message d'un nouveau contact — une seule fois, jamais répété ensuite.
- Facultatif et vide par défaut : un marchand qui n'en envoie pas ne voit et n'envoie rien de nouveau.
- **Important — nécessite l'hébergement d'images déjà utilisé pour les photos d'articles** (Cloudflare
  R2, variables `R2_*` sur Render — voir la section correspondante du README principal du projet). Sans
  cette configuration, le bouton "Envoyer" du logo renvoie une erreur claire au lieu de planter,
  exactement comme pour les photos d'articles.

**Petit bug pré-existant corrigé au passage** (repéré en travaillant sur le stockage du logo, sans
rapport avec le bilingue) : dans certaines conditions, changer le numéro de notification, suspendre/
réactiver un marchand, ou corriger son nom/numéro WhatsApp depuis /admin, effaçait silencieusement la
liste de ses employés en base de données (uniquement en production avec PostgreSQL — pas en mode local
sans base de données). C'est corrigé, testé avec une vraie base PostgreSQL avant livraison, et cela ne
demande aucune action de votre part.

Testé de bout en bout avant livraison : logo affiché dans /admin et envoyé par le bot en premier message,
suppression/remplacement, erreur claire sans configuration R2, et le correctif employés vérifié avec une
vraie base PostgreSQL (pas seulement le mode local).

## Étape 6 — Logo et image d'accueil WhatsApp séparés en deux champs indépendants (nouveau)

Suite à votre question ("permets que le marchand ait le choix... ou peut-être deux endroits, le logo
pour sa plateforme et le logo pour les messages"), le bloc "Logo" unique de l'Étape 5 est maintenant
**scindé en deux champs totalement indépendants** dans l'onglet **Mon compte** :

1. **"Logo (interface /admin)"** — inchangé par rapport à l'Étape 5 : affiché uniquement en haut de
   l'écran /admin, jamais envoyé sur WhatsApp. C'est votre identité de marque stable.
2. **"Image d'accueil WhatsApp"** (nouveau) — envoyée par le bot au tout premier message d'un nouveau
   contact (avant le message de bienvenue bilingue), exactement comme le faisait le logo à l'Étape 5.
   Vous pouvez la changer librement — un flyer de promo, une offre du moment — **sans jamais toucher à
   votre logo officiel**.

**Comportement important, confirmé avec vous avant de coder** : les deux champs n'ont AUCUN lien entre
eux. Si vous mettez un logo (interface /admin) mais laissez l'image d'accueil WhatsApp vide, le bot
n'envoie **aucune image** au premier contact (pas de repli automatique sur le logo). Et inversement, si
vous mettez seulement une image d'accueil WhatsApp, elle n'apparaît jamais dans /admin. Chaque champ se
gère (upload/suppression) indépendamment, dans les deux vues (super-administrateur et marchand).

Si vous aviez déjà un logo envoyé via l'Étape 5, il reste affiché dans /admin (rien ne change pour vous)
mais n'est plus envoyé automatiquement sur WhatsApp — remettez-le (ou une autre image) dans le nouveau
bloc "Image d'accueil WhatsApp" si vous voulez continuer à l'envoyer aux clients.

Testé de bout en bout avant livraison (avec une vraie base PostgreSQL locale, comme pour le correctif
employés de l'Étape 5) : logo seul → aucune image envoyée au premier contact ; image d'accueil seule →
envoyée en premier, logo /admin non affecté ; les deux ensemble → chacun affiché/envoyé au bon endroit ;
suppression de l'un sans effet sur l'autre ; les deux champs survivent à une modification non liée
(numéro de notification, etc.) sans être effacés ; interface vérifiée en français et en anglais, dans
la vue super-administrateur et dans la vue marchand.

## Étape 7 — Bouton "Tester l'alerte maintenant" (diagnostic, nouveau)

Suite à un cas réel où vous ne receviez ni l'alerte "commande confirmée" ni l'alerte "parler à un
humain" pour le marchand Test Izyvendeur, alors que vos templates WhatsApp étaient pourtant bien
"Actif" côté Meta.

**Deux précisions importantes avant l'explication technique**, pour écarter deux fausses pistes :

- **L'alerte "commande confirmée" ne se déclenche QUE quand le CLIENT confirme sa commande en tapant
  "oui" dans la conversation WhatsApp** (confirmation automatique) — pas quand vous confirmez
  vous-même une commande manuellement depuis /admin, onglet Commandes. Si votre test consistait à
  confirmer une commande depuis /admin, c'est normal qu'aucune alerte ne soit partie : ce n'est pas un
  bug, juste un comportement à connaître.
- **L'alerte "humain" ne se déclenche que si le client tape une phrase reconnue** ("parler à un
  conseiller", "un vendeur", "talk to a human"...) — la liste complète est dans `shared.js`.

Cela dit, ces deux précisions n'expliquent pas tout, donc j'ai ajouté un nouveau bouton **"Tester
l'alerte maintenant"** juste sous le champ "Numéro de notification" dans l'onglet **Mon compte**
(visible pour vous en tant que super-administrateur, et pour chaque marchand sur son propre compte).
Il envoie une VRAIE alerte de test (le même template que "parler à un humain") au numéro de
notification enregistré, et affiche directement à l'écran, en clair, le résultat exact renvoyé par
WhatsApp :

- **Succès** (fond vert) : l'alerte est bien partie via le template WhatsApp. Si elle n'arrive
  toujours pas sur votre téléphone dans ce cas, le souci est probablement le numéro lui-même (mauvais
  numéro enregistré, ou WhatsApp désinstallé/désactivé sur cet appareil), pas IzyVendeur.
- **Partiel** (fond orange) : le template a échoué, mais un message de secours en texte libre est
  quand même arrivé. Cela signifie que votre numéro et votre jeton WhatsApp fonctionnent bien — le
  problème vient précisément du template (nom incorrect, pas approuvé, ou **approuvé sous un compte
  WhatsApp Business différent de celui réellement branché sur Render** — j'ai remarqué sur vos
  captures que vous avez plusieurs comptes WhatsApp nommés "Test Izyvendeur" : si le template est
  actif sur l'un d'eux mais que c'est un AUTRE qui est configuré comme PHONE_NUMBER_ID sur Render,
  l'envoi échoue silencieusement malgré le statut "Actif" affiché dans Meta).
- **Échec complet** (texte rouge) : ni le template ni le texte libre de secours ne sont partis.
  L'erreur brute renvoyée par WhatsApp est affichée telle quelle (code d'erreur Meta compris), pour
  que vous puissiez la interpréter vous-même ou me la transmettre.

Dans les trois cas, le détail technique complet (code HTTP + message d'erreur exact de Meta) s'affiche
sous le résultat, pour diagnostiquer sans avoir besoin d'aller consulter les logs du serveur sur
Render.

Testé de bout en bout avant livraison (base PostgreSQL réelle + API WhatsApp simulée pour les trois cas
de figure : succès, échec du template avec repli réussi, échec complet) dans les deux vues
(super-administrateur et marchand), avec vérification visuelle du rendu (navigateur automatisé).

## Étape 8 — Exemple de format ajouté à la demande du numéro de téléphone (nouveau)

Petite amélioration demandée pour guider le client : partout où le bot lui demande son numéro de
téléphone pour conclure une commande, un exemple de format est maintenant ajouté entre parenthèses
— **"(exemple : 6xxxxxxxx)"** — dans les 4 endroits concernés : le récapitulatif du panier qui demande
numéro + adresse d'un coup (le cas le plus fréquent), la demande de numéro après un choix "retrait en
boutique", la demande après un choix "livraison à domicile" (pour les marchands qui ont activé le
retrait en boutique dans Paramètres), et la relance "il me manque encore..." si le client n'a donné
que l'adresse. Le format "6xxxxxxxx" (un modèle générique avec des x, pas un vrai numéro) a été
préféré à un numéro qui aurait pu ressembler à un numéro réellement utilisé — sur votre remarque.
Traduit en anglais également ("e.g. 6xxxxxxxx"). Testé de bout en bout avant livraison (commande
complète en français et en anglais, avec et sans retrait en boutique configuré, cas où le client ne
donne que l'adresse).

## Étape 9 — Formule de politesse quand le client ne confirme pas sa commande (nouveau)

Petite amélioration de ton demandée : quand un client répond "non" à la confirmation automatique de sa
commande, le bot ajoute maintenant un remerciement à la fin de son message ("Merci pour votre
confiance !", "Merci pour votre intérêt !", "Merci et à bientôt !", "Merci pour votre visite !" — une
formule tirée au hasard parmi plusieurs, jamais toujours la même, sur le même principe que les petits
mots valorisants déjà utilisés ailleurs dans le bot). Sa commande reste bien enregistrée pour que vous
puissiez la confirmer manuellement depuis /admin, seul le ton du message change. Traduit en anglais
également ("Thank you for your trust!", "Thanks for your interest!"...). Testé de bout en bout avant
livraison (plusieurs déclinaisons en français et en anglais pour vérifier la variété des formulations).

## Étape 10 — Lien de commande WhatsApp par article (nouveau)

Demandé pour les marchands qui postent leurs articles dans des groupes WhatsApp (par exemple une
marchande qui trouve un article intéressant, le poste dans plusieurs groupes, et devait jusqu'ici
répondre manuellement à chaque client intéressé). Les groupes WhatsApp eux-mêmes ne permettent pas
d'automatiser ce genre de réponse (l'API de groupes de Meta est limitée à 8 participants et ne
supporte pas les menus tactiles utilisés par le bot) — la solution retenue est donc de rediriger le
client vers une conversation directe avec le numéro business du marchand, où le bot prend le relais
automatiquement comme d'habitude.

Concrètement : un nouveau réglage "Numéro WhatsApp affiché" a été ajouté dans /admin > Mon compte (le
numéro que vos clients contactent réellement, distinct de l'identifiant technique `phone_number_id`
déjà utilisé côté serveur). Une fois ce numéro renseigné, chaque article de l'onglet Catalogue affiche
un bouton "Copier le lien de commande" qui génère un lien `wa.me` prêt à coller dans un post de groupe
— le client n'a plus qu'à cliquer et envoyer le message pré-rempli ("Bonjour, je suis intéressé(e)
par : <nom de l'article>" / l'équivalent anglais si votre interface /admin est en anglais) pour tomber
directement dans la conversation avec le bot. Facultatif : tant que le numéro n'est pas configuré, une
note l'indique à la place du bouton. Testé de bout en bout (vraie base PostgreSQL, vues
super-administrateur ET marchand, français et anglais) avant livraison.

## Étape 11 — Case "Stock illimité" par article (nouveau)

Question soulevée directement par l'Étape 10 ci-dessus : pour un article "trouvaille" sans stock suivi,
le bot vérifiait jusqu'ici le stock réel avant chaque vente — resté à 0 par défaut sur un nouvel
article, il aurait dit "en rupture" à TOUS les clients. Nouvelle case à cocher "Stock illimité" par
article dans l'onglet Catalogue : une fois cochée, le bot ne vérifie plus jamais le stock de cet
article et ne le proposera jamais comme en rupture, quelle que soit la quantité demandée — stock réel
et seuil d'alerte sont simplement ignorés tant que la case reste cochée (mais restent visibles et
modifiables, pour le jour où vous la décochez). La colonne "Stock virtuel" affiche alors "∞ Illimité"
au lieu d'un chiffre. Décochable à tout moment, à la guise du marchand. Testé de bout en bout : moteur
de conversation (une commande de 50 pièces acceptée sur un article à stock réel 0 marqué illimité, un
article normal continue lui de refuser au-delà de son vrai stock) et interface /admin (case cochée,
enregistrement, et persistance vérifiée après un rechargement complet de la page, vraie base
PostgreSQL).

## Étape 12 — Stock illimité et Lien de commande transformés en options payantes (nouveau)

Suite logique des Étapes 10 et 11 : IzyVendeur n'était pas prévu à l'origine pour ces deux
améliorations — vous seul, en tant que super-administrateur, pouvez désormais les débloquer,
indépendamment l'une de l'autre, pour chaque marchand. Nouveau bloc "Options payantes" tout en haut de
/admin > Mon compte, visible UNIQUEMENT par vous (jamais par un marchand, même celui concerné) : deux
cases à cocher, "Stock illimité" et "Lien de commande", avec un bouton Enregistrer. Tant qu'une option
n'est pas cochée pour un marchand, il ne voit RIEN de la fonctionnalité correspondante — ni la case
"Stock illimité" dans son Catalogue, ni le bouton "Copier le lien de commande", ni le champ "Numéro
WhatsApp affiché" dans son Mon compte. Dès que vous cochez l'option, tout réapparaît instantanément
pour lui.

Protection ajoutée aussi côté serveur (pas seulement l'affichage) : même en cas d'appel direct à
l'API (hors interface /admin), impossible pour un marchand d'activer une case "Stock illimité" sur un
article tant que l'option n'est pas débloquée pour lui (silencieusement ignorée à l'enregistrement du
catalogue), et impossible d'enregistrer un numéro WhatsApp affiché sans l'option "Lien de commande"
(refusé explicitement). Par défaut, les deux options sont désactivées pour TOUS les marchands existants
(y compris ceux qui avaient déjà testé ces fonctionnalités) — rien n'était encore activé au moment de
cette bascule. Testé de bout en bout (vraie base PostgreSQL) : refus confirmé pour un marchand qui
tente de s'auto-débloquer, activation par vous puis apparition immédiate des fonctionnalités côté
super-administrateur ET côté marchand self-service, filtrage serveur vérifié par appel API direct.

## Étape 13 — Le lien de commande atterrit directement sur l'article après le choix de langue (correction)

Bug remonté après test réel de l'Étape 10 : un client qui cliquait sur le lien de commande d'un
article se retrouvait, une fois sa langue choisie, renvoyé sur le catalogue général au lieu
d'atterrir directement sur l'article visé — le texte pré-rempli du lien ("Bonjour, je suis
intéressé(e) par : Robe wax bleue") était traité uniquement comme déclencheur de la porte de langue,
puis jeté sans être réutilisé.

Corrigé : le texte du tout premier message d'un client (celui qui déclenche la porte de langue FR/EN)
est maintenant mémorisé le temps du choix de langue, puis automatiquement repassé dans la
reconnaissance d'article juste après. Résultat : un client qui clique sur le lien "Robe wax bleue",
choisit sa langue, se retrouve directement face à la question couleur/taille/quantité de cet article
— exactement le comportement décrit lors de la construction de l'Étape 10.

Aucun changement pour un client qui écrit normalement (sans passer par un lien) : son premier message
("Bonjour" par exemple) est traité de la même façon qu'avant, il tombe sur la liste des articles une
fois sa langue choisie. Aucun autre flux touché (panier, livraison, confirmation de commande, options
payantes). Testé par appel direct du moteur de conversation : lien + choix FR → atterrit sur la
question de taille (couleur déjà reconnue dans le texte du lien) ; lien + choix EN → atterrit
directement sur la question de quantité (article à couleur/taille uniques) en anglais ; message
classique sans lien → comportement inchangé (liste des articles proposée).

## Étape 14 — Un article "Stock illimité" n'affiche plus de nombre de pièces au client (correction)

Bug remonté le 15 septembre 2026 : pour un article marqué "Stock illimité" (Étape 11), le bot
affichait quand même un nombre de pièces en stock au client dans le message "il est disponible"
— en réalité le chiffre interne utilisé en coulisses pour ne jamais bloquer la vente (999999), ce
qui donnait un message absurde du type "(999999 pièce(s) en stock)".

Corrigé : quand un article est en Stock illimité, le bot ne mentionne plus du tout de nombre de
pièces dans ce message ("il est disponible ✅ Robe wax bleue Bleu M — 15 000 FCFA l'unité. Combien
de pièces souhaitez-vous ?"). Aucun changement pour un article à stock normal, qui continue
d'afficher son nombre de pièces réellement disponibles comme avant. Testé par appel direct du
moteur de conversation avec un article en Stock illimité et un article à stock normal côte à côte.

## Étape 15 — Nouveau statut "Commandée" + notifications WhatsApp au client sur changement de statut (nouveau, option payante)

Discussion tenue le 15-16 septembre 2026 (retours marchands) avant construction. Deux ajouts liés :

**Nouveau statut "Commandée"**, place entre "Confirmée" et "Expédiée" dans le suivi de commande
(onglet Commandes) : pensé pour les marchands façon dropshipping, pour signaler que l'article a été
commandé auprès du fournisseur. Comme "Confirmée" et "Expédiée", ce statut réserve le stock (un
autre client ne peut pas commander le même article tant qu'il est "Commandée") — pas de trou de
survente pendant que l'article est chez le fournisseur.

**Notifications de statut** : un message WhatsApp automatique peut désormais être envoyé au CLIENT
quand une de ses commandes passe à Commandée, Expédiée, Livrée, ou Annulée. Chaque statut s'active
indépendamment ("Confirmée" n'a pas été ajoutée exprès : le message de confirmation automatique
existant la couvre déjà). Pour "Annulée", la raison d'annulation (si renseignée) est automatiquement
ajoutée au message — pensé pour protéger le marchand en cas de litige. Texte personnalisable par
statut, bilingue FR/EN (le client reçoit le message dans sa propre langue ; si vous ne remplissez
que le français, un client anglophone reçoit un message par défaut en anglais, jamais votre texte
français). "{ref}" dans votre texte est remplacé par la référence de la commande (ex : CMD-0042).

Comme Stock illimité et Lien de commande, cette fonctionnalité est **une option payante réservée à
vous** : nouvelle case "Notifications de statut" dans le bloc "Options payantes" de Mon compte
(super-administrateur uniquement). Tant qu'elle n'est pas cochée pour un marchand, il ne voit ni le
nouveau bloc de réglages dans Paramètres, ni ne peut l'activer par un appel API direct (filtrage
côté serveur en plus de l'interface, même principe que les deux options précédentes).

Testé de bout en bout le 16 septembre 2026 : conversation complète (appel direct du moteur ET vraie
base PostgreSQL via un webhook simulé) créant une commande réelle, statut "Commandée" apparaissant
au bon endroit dans le menu déroulant, réservation de stock vérifiée pendant "Commandée", message
par défaut envoyé quand le marchand active un statut sans avoir écrit de texte, texte personnalisé
avec "{ref}" substitué, repli sur le message anglais par défaut (jamais le texte français) pour un
client ayant choisi English, raison d'annulation automatiquement ajoutée pour "Annulée", persistance
des réglages après rechargement de la page, et blocage confirmé d'une tentative de contournement par
appel API direct tant que l'option n'est pas débloquée.

## Étape 16 — "Contacter un conseiller" (renommage) + choix réponse écrite/rappel + reprise à 5 min (nouveau)

Demandé le 16 septembre 2026 : le bouton/menu "Parler à un conseiller" laissait penser à un échange
vocal alors que tout se passe par écrit sur WhatsApp — renommé en **"Contacter un conseiller"** /
"Contact an advisor" partout où il apparaît (menu déroulant du catalogue/services, boutons de choix
livraison, menu du panier).

**Choix réponse écrite ou rappel** : dès qu'un client demande à être mis en relation avec un humain
(bouton "Contacter un conseiller" ou phrase libre du type "je veux parler à un conseiller"), le bot
lui pose UNE question tactile ("Réponse ici" / "Être rappelé(e)") avant de le mettre en attente.
Aucun numéro supplémentaire n'est demandé : c'est le numéro WhatsApp du client qui sert de numéro de
rappel. Vous recevez l'alerte habituelle dès la demande initiale (comme avant, sans délai) ; si le
client choisit ensuite "Être rappelé(e)", vous recevez un second message signalant sa préférence
(préfixé "[Préfère être rappelé(e)]"), sans toucher au nombre de variables de votre modèle Meta
`izyvendeur_alerte_humain` déjà approuvé — seul le texte à l'intérieur change. Si le client choisit
"Réponse ici", rien de plus ne vous est envoyé.

**Le choix d'un rappel n'empêche jamais l'écrit** : c'est exactement le même mécanisme de mise en
pause dans les deux cas — si l'appel ne peut pas aboutir (mauvais numéro, indisponibilité...), la
conversation écrite reste le filet de sécurité, avec la même reprise automatique décrite ci-dessous.

**Délai de pause réduit à 5 minutes** (au lieu de 10) : si vous n'avez pas répondu au client dans les
5 minutes suivant sa demande (écrite ou par téléphone), le bot reprend automatiquement la main — mais
annonce désormais clairement la reprise ("Merci de votre patience 🙏 Pouvons-nous continuer, là où
nous nous étions arrêté(e)s ?") au lieu de répondre silencieusement comme avant. Le panier/la sélection
en cours du client est toujours conservé(e) tel(le) quel(le) pendant toute la pause, reprise incluse.

⚠️ Limite technique WhatsApp à connaître : cette phrase de reprise ne peut être envoyée qu'en réaction
au PROCHAIN message du client après les 5 minutes (WhatsApp n'autorise pas d'envoi spontané en dehors
d'une réponse à un message entrant) — si le client ne réécrit jamais, il ne la reçoit simplement pas,
mais le bot reste évidemment prêt à répondre normalement dès qu'il écrit à nouveau.

En prime, un bug préexistant a été corrigé au passage : côté moteur rendez-vous
(`conversationService.js`), le message envoyé au client lors d'une demande d'humain, ainsi que la
mention "un conseiller reste disponible", référençaient des constantes qui n'existaient pas dans
`shared.js` — le client recevait donc littéralement le mot "undefined" au lieu du message prévu. Ce
volet est maintenant branché sur les mêmes fonctions que le moteur catalogue et testé en conséquence.

Testé par appel direct des deux moteurs (catalogue et rendez-vous) le 16 septembre 2026 : question
écrit/appel posée à la demande d'un humain, alerte marchand immédiate avec le texte d'origine,
confirmation écrite correcte, confirmation "on vous appelle" correcte avec second message marchand
préfixé, silence du bot pendant la pause, reprise automatique après 5 minutes avec la phrase attendue
ET poursuite exacte de la sélection en cours (couleur déjà choisie conservée), et absence du mot
"undefined" pour un premier contact côté moteur rendez-vous.

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
  calcul du Tableau de bord/Rapports par période (jour/semaine/mois/trimestre/année), exemple de
  format ajouté à la demande du numéro de téléphone (Étape 8), formule de politesse ajoutée quand le
  client ne confirme pas sa commande (Étape 9), vérification de stock qui ignore les articles marqués
  "Stock illimité" (Étape 11), mémorisation du texte du premier message pour le réutiliser juste
  après le choix de langue (Étape 13), suppression de l'affichage du nombre de pièces pour un
  article en Stock illimité (Étape 14), nouveau statut de commande "Commandée" (réservant le
  stock comme Confirmée/Expédiée) + envoi des notifications de statut au client (Étape 15), et
  question "réponse écrite ici / être rappelé(e)" à la demande d'un humain + délai de pause réduit
  à 5 minutes avec phrase de reprise explicite (Étape 16)
- `conversationService.js` — moteur rendez-vous : reste en français (voir plus bas), mais reçoit la même
  logique de calcul du Tableau de bord par période que le moteur catalogue, ainsi que la même question
  "réponse écrite ici / être rappelé(e)" et la même reprise à 5 minutes que le moteur catalogue, en
  corrigeant au passage un bug préexistant (message "undefined" envoyé au client, voir Étape 16)
- `shared.js` — fonctions de gestion de langue partagées (utilisées aussi plus tard par le moteur RDV) +
  question réponse écrite/rappel, préfixe d'alerte marchand pour le choix "rappel", délai de pause ramené
  à 5 minutes et signal de reprise consommé une seule fois après expiration automatique (Étape 16)
- `catalog.js` — message de confirmation par défaut en anglais
- `server.js` — reconnaissance du message de mise en relation dans les 2 langues + **menu déroulant
  tactile Français/English** pour la porte de langue (au lieu de devoir taper FR/EN), sur le même
  principe que les autres menus cliquables déjà présents dans le bot (choix d'article, couleur, taille...)
  + traduction de TOUS les menus tactiles eux-mêmes (titres de listes/boutons) selon la langue du client
  + la route du Tableau de bord accepte maintenant un paramètre de période + nouvelle route
  `POST /api/marchands/:id/tester-alerte` (bouton "Tester l'alerte maintenant", voir Étape 7) +
  nouvelle route `PUT /api/:id/numero-whatsapp-public` (numéro WhatsApp affiché, voir Étape 10) +
  nouvelle route `PUT /api/marchands/:id/options-payantes` (réservée au super-administrateur, voir
  Étape 12) + filtrage serveur sur `PUT /api/:id/catalogue` et `PUT /api/:id/numero-whatsapp-public`
  qui empêche un contournement de ces options par appel direct à l'API + route
  `PUT /api/marchands/:id/options-payantes` étendue à une 3e option (`optionNotificationsStatut`) +
  filtrage serveur équivalent sur `PUT /api/:id/parametres` (bloc `notifStatut`) + branchement de
  l'envoi de notification client sur `PUT /api/:id/commandes/:orderId/statut` (Étape 15) +
  renommage "Parler à un conseiller" → "Contacter un conseiller" partout + nouveau menu tactile à 2
  boutons "Réponse ici" / "Être rappelé(e)" (Étape 16)
- `public/admin.html` — interface /admin entièrement bilingue (bouton FR/EN) + sélecteur de période sur
  le Tableau de bord + Trimestre/Année ajoutés à l'onglet Rapports + nouveau champ "Message d'accueil
  personnalisé" dans l'onglet Paramètres + deux blocs indépendants "Logo (interface /admin)" et "Image
  d'accueil WhatsApp" dans l'onglet Mon compte + nouveau bouton "Tester l'alerte maintenant" (Étape 7)
  + nouveau champ "Numéro WhatsApp affiché" et bouton "Copier le lien de commande" par article dans
  l'onglet Catalogue (Étape 10) + case "Stock illimité" par article, avec affichage "∞ Illimité" dans
  la colonne Stock virtuel (Étape 11) + nouveau bloc "Options payantes" réservé au super-administrateur
  dans Mon compte, qui masque entièrement les deux fonctionnalités ci-dessus côté marchand tant qu'elles
  ne sont pas débloquées (Étape 12) + statut "Commandée" ajouté au menu déroulant des commandes + nouveau
  bloc "Notifications de statut" (4 statuts activables indépendamment, texte bilingue par statut) dans
  l'onglet Paramètres, visible uniquement si l'option est débloquée + 3e case dans "Options payantes"
  (Étape 15)
- `storage.js` — fonctions d'upload pour le logo ET pour l'image d'accueil WhatsApp (deux dossiers
  séparés, même hébergement Cloudflare R2 déjà en place pour les photos d'articles)
- `db.js` — nouvelles colonnes `logo_url` et `image_accueil_whatsapp_url` pour le marchand (avec
  migration automatique au démarrage) + correctif du bug employés décrit ci-dessus, étendu pour protéger
  également ces deux colonnes + nouvelle colonne `numero_whatsapp_public` (Étape 10) + nouvelles colonnes
  `option_stock_illimite` et `option_lien_commande`, fausses par défaut pour tous les marchands existants
  (Étape 12) + nouvelle colonne `option_notifications_statut`, fausse par défaut (Étape 15)

## Comment déployer

1. Remplacez les 8 fichiers ci-dessus dans votre dépôt par ceux de ce zip (mêmes emplacements).
2. `git add -A && git commit -m "Choix de langue FR/EN + sélecteur de période sur le Tableau de bord"`
3. `git push`
4. Render redéploie automatiquement (ou lancez un "Manual Deploy" depuis le tableau de bord Render
   si l'auto-deploy n'est pas activé).

Testez ensuite en envoyant "hello" ou "hi" à votre numéro WhatsApp bot (message de bienvenue bilingue),
et en ouvrant /admin pour essayer le bouton FR/EN en haut de l'écran.
