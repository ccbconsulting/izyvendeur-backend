# IzyVendeur — Backend (multi-marchand)

Serveur qui reçoit les messages WhatsApp (via le webhook Meta) et répond automatiquement, pour
plusieurs marchands à la fois — chacun avec son propre numéro WhatsApp, son propre catalogue ou ses
propres services, et ses propres commandes ou rendez-vous, sans jamais se mélanger.

Deux types de marchand sont pris en charge :

- **catalogue** : vente de produits par variantes (couleur/taille), panier, livraison — le module
  d'origine (coiffeur → non, plutôt boutique mode/cosmétique/accessoires).
- **service** : prise de rendez-vous (coiffeur, institut de beauté, clinique...) — le client nomme un
  service, indique un jour/une heure, le bot vérifie la disponibilité et confirme.

## Déploiement sur Render.com (gratuit pour démarrer)

### 1. Mettre le code sur GitHub

1. Créez un compte sur [github.com](https://github.com) si vous n'en avez pas.
2. Créez un nouveau dépôt (bouton vert "New").
3. Uploadez-y tous les fichiers de ce dossier (`server.js`, `db.js`, `conversation.js`, `conversationService.js`, `catalog.js`, `services.js`, `shared.js`, le dossier `public/` avec `admin.html` dedans, `package.json`, `.gitignore`, `.env.example`, `README.md`) — utilisez le bouton "Add file > Upload files" sur la page du dépôt, glissez les fichiers (et le dossier `public/`), puis "Commit changes".
   - Ne mettez jamais le fichier `.env` (avec vos vrais secrets) sur GitHub — le `.gitignore` fourni l'exclut automatiquement si vous utilisez git en ligne de commande.

### 2. Créer la base de données PostgreSQL (gratuite)

Avant de créer le service web, créez d'abord la base : c'est elle qui va conserver le catalogue et les
commandes de façon durable, même quand Render redéploie ou redémarre le serveur.

1. Sur Render, cliquez "New +" > "PostgreSQL".
2. **Name** : `izyvendeur-db` (ou ce que vous voulez).
3. **Region** : la même que celle que vous choisirez pour le service web (à l'étape suivante).
4. **Instance Type** : Free.
5. Cliquez "Create Database". Après quelques secondes, Render affiche la page de la base.
6. Copiez la valeur **"Internal Database URL"** (pas "External") — c'est l'adresse de connexion à la
   base, elle ressemble à `postgresql://izyvendeur:xxxxx@dpg-xxxxx/izyvendeur_db`. Vous en aurez besoin
   juste après. (L'option "Internal" est plus rapide et gratuite en usage réseau car le service web et la
   base tournent sur le même réseau interne Render.)

### 3. Créer le service sur Render

1. Allez sur [render.com](https://render.com) et créez un compte (vous pouvez vous inscrire avec votre compte GitHub, c'est plus simple).
2. Cliquez "New +" > "Web Service".
3. Connectez votre dépôt GitHub (celui créé à l'étape 1).
4. Réglages du service :
   - **Name** : `izyvendeur-backend` (ou ce que vous voulez)
   - **Region** : la même que la base de données créée à l'étape précédente
   - **Branch** : `main`
   - **Runtime** : Node
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
5. Dans la section **Environment Variables**, ajoutez ces 4 variables (les mêmes que dans `.env.example`) :
   - `VERIFY_TOKEN` → inventez une chaîne secrète (ex: `izyvendeur-2026-secret`), notez-la, vous en aurez besoin juste après.
   - `WHATSAPP_TOKEN` → le token d'accès **permanent** généré via Utilisateur Système (Business Settings > System Users). Pas le token temporaire de 24h. Ce même token sert pour TOUS les marchands (il faut juste que le Système Utilisateur ait accès à chacun de leurs WABA).
   - `PHONE_NUMBER_ID` → le Phone Number ID de VOTRE numéro à vous (le premier marchand, migré automatiquement en marchand `"default"` au premier démarrage) — visible dans WhatsApp Manager > Numéros de téléphone > roue crantée, ou dans l'API Setup. Les marchands suivants n'ont pas besoin de variable d'environnement : ils s'ajoutent depuis l'interface `/admin` (voir plus bas).
   - `DATABASE_URL` → collez l'"Internal Database URL" copiée à l'étape 2.
   - `ADMIN_USER` → un nom d'utilisateur pour protéger l'interface d'administration `/admin` (ex : `admin`).
   - `ADMIN_PASSWORD` → un mot de passe de votre choix, connu de vous seul. **Sans cette variable,
     `/admin` et toute l'API refusent l'accès** (par sécurité — elles affichent les téléphones, adresses
     et noms de vos clients, elles ne doivent pas être ouvertes à n'importe qui tombant sur l'URL).
6. Cliquez "Create Web Service". Render va installer et démarrer le serveur (2-3 minutes).
7. Une fois déployé, Render vous donne une adresse du type : `https://izyvendeur-backend.onrender.com`

**Important** : si un service `izyvendeur-backend` existe déjà (sans base de données) et que vous ajoutez
`DATABASE_URL` dessus, le tout premier démarrage repart du catalogue de départ (les anciennes commandes
enregistrées dans l'ancien `data.json` ne sont pas migrées automatiquement — dites-le moi si vous voulez
garder une commande de test précise, je peux écrire un petit script de migration ponctuel).

### 4. Brancher l'adresse dans Meta

1. Retournez dans le tableau de bord Meta for Developers > votre app > cas d'utilisation WhatsApp > Étape 2 > "Configurer des webhooks".
2. **URL de rappel** : `https://izyvendeur-backend.onrender.com/webhook` (bien ajouter `/webhook` à la fin).
3. **Vérifier le token** : collez exactement la même valeur que celle mise dans `VERIFY_TOKEN` sur Render.
4. Cliquez "Vérifier et enregistrer". Si tout est correct, Meta valide instantanément (le serveur répond au défi de vérification).
5. Abonnez-vous au champ `messages` si Meta vous le demande (case à cocher séparée, souvent juste en dessous).

### 5. Tester en vrai

Envoyez un message WhatsApp depuis votre téléphone personnel vers votre numéro business. Vous devriez recevoir une réponse automatique de test en quelques secondes. Vous pouvez aussi surveiller les logs en direct dans l'onglet "Logs" de Render pour voir le message arriver côté serveur.

## Limite du plan gratuit Render à connaître

Le plan gratuit "s'endort" après 15 minutes sans trafic, et met quelques secondes à se réveiller au message suivant (léger délai la première fois). Pour un usage réel avec des clients, il faudra passer sur un plan payant (à partir de quelques dollars/mois) une fois qu'on avance vers la production — mais pour tester et développer, le gratuit suffit largement.

## Comment un message arrive au bon marchand

Meta indique toujours, dans chaque message reçu, le `phone_number_id` du numéro WhatsApp qui l'a reçu.
Le serveur tient un registre des marchands (table `merchants` en base, ou `merchants.json` en local) qui
associe chaque `phone_number_id` à un marchand et son type — c'est ce qui permet à un seul serveur de
gérer plusieurs marchands, chacun avec son propre numéro, sans jamais mélanger leurs catalogues, leurs
services, leurs commandes ou leurs rendez-vous.

Au tout premier démarrage, si le registre est vide, un marchand `"default"` (type catalogue) est recréé
automatiquement à partir des variables d'environnement historiques (`PHONE_NUMBER_ID`) — rien à faire,
l'installation existante continue de fonctionner à l'identique.

## Ajouter un nouveau marchand

1. Côté Meta : ajoutez le numéro WhatsApp du marchand à votre app (WhatsApp Manager > Numéros de
   téléphone > Ajouter), notez son **Phone Number ID**, et abonnez votre app aux événements de son WABA
   si nécessaire (comme pour votre propre numéro).
2. Connectez-vous sur `/admin` avec vos identifiants de super-administrateur (`ADMIN_USER`/
   `ADMIN_PASSWORD`) et cliquez **"+ Nouveau marchand"** : indiquez un identifiant technique (ex:
   `don-william`), un nom, le type (`catalogue` ou `service`), le Phone Number ID noté à l'étape 1, et un
   nom d'utilisateur + mot de passe **propres à ce marchand** — ce sont ces identifiants (pas les vôtres)
   qu'il utilisera pour se connecter à `/admin` et gérer lui-même ses données.
3. Le marchand apparaît aussitôt dans le sélecteur en haut de `/admin` (visible par vous uniquement,
   voir section suivante) — vous pouvez y configurer son catalogue/stock (ou ses services et ses
   horaires), et il commence à recevoir de vrais messages WhatsApp sur son propre numéro immédiatement.

(Cette étape reste manuelle pour l'instant — l'onboarding en libre-service, où le marchand connecterait
lui-même son numéro via l'"Embedded Signup" de Meta sans intervention de votre part, est un chantier
séparé, à construire une fois qu'on aura validé la formule avec quelques marchands pilotes.)

## La logique de conversation

Deux moteurs de conversation distincts, un par type de marchand — chaque marchand a sa propre instance
avec son propre état et ses propres sessions de conversation en cours, ce qui évite tout mélange entre
marchands même si deux clients de deux marchands différents écrivent au même moment.

**Marchand catalogue** (fichier `conversation.js`, catalogue de départ dans `catalog.js`) :

- Chaque client (identifié par son numéro WhatsApp) a sa propre conversation en cours, donc plusieurs
  clients peuvent discuter en même temps sans se mélanger.
- Le moteur reconnaît l'article, la couleur et la taille demandés en cherchant dans le catalogue — pas
  de dictionnaire à maintenir à la main, tout nouvel article du catalogue est reconnu automatiquement.
- Le stock "virtuel" (stock réel moins ce qui est déjà réservé par des commandes Confirmée/Expédiée) est
  vérifié avant de proposer l'article.
- Le client peut ajouter plusieurs articles dans son panier avant de passer à la livraison.
- Une fois le numéro et l'adresse de livraison reçus, une vraie commande est créée, visible et gérable
  depuis `/admin` (onglet Commandes).
- Si le client confirme, le message de confirmation automatique (personnalisable depuis `/admin` >
  Paramètres) est envoyé et la commande passe au statut "Confirmée".

**Marchand service** (fichier `conversationService.js`, services de départ dans `services.js`) :

- Le client nomme un service (reconnu de la même façon que les articles côté catalogue) ; le moteur lui
  demande un jour et une heure si ce n'est pas déjà précisé dans le même message.
- La disponibilité est vérifiée par rapport aux horaires d'ouverture et à la durée de créneau configurés
  (une seule ressource à la fois par marchand — ex: un seul fauteuil/praticien — avec des créneaux de
  durée fixe ; chaque service occupe un nombre entier de créneaux selon sa propre durée).
- Si le créneau demandé n'est pas libre, jusqu'à 3 créneaux proches sont proposés (le jour même, ou les
  jours suivants si le jour demandé est complet).
- Une fois un créneau choisi et le nom du client obtenu, un rendez-vous est créé (statut "Nouvelle",
  déjà réservé pour empêcher qu'un autre client ne prenne le même créneau entre-temps), visible et
  gérable depuis `/admin` (onglet Rendez-vous). La confirmation du client passe le statut à "Confirmé".
- Services, horaires d'ouverture, durée de créneau et message de confirmation se configurent tous depuis
  `/admin` (onglets Services et Paramètres).

**Où sont sauvegardées les données ?** Dans une vraie base de données PostgreSQL (fichier `db.js`),
tant que la variable `DATABASE_URL` est configurée (voir étape 2) — catalogue/services et
commandes/rendez-vous de chaque marchand survivent aussi bien à la mise en veille/réveil du plan gratuit
Render qu'aux redéploiements : plus rien n'est perdu. Si `DATABASE_URL` n'est pas définie (par exemple en
test local sans base installée), le serveur retombe automatiquement sur des fichiers `data.json` et
`merchants.json` locaux. Les conversations en cours (à quelle étape en est chaque client) restent, elles,
uniquement en mémoire : si le serveur redémarre en plein milieu d'une commande ou d'une prise de
rendez-vous, le client devra reformuler sa demande depuis le début — ça reste un comportement acceptable
pour cette étape.

## Interface d'administration (`/admin`)

Remplace l'ancienne page `/commandes` en lecture seule (qui redirige maintenant vers `/admin`). Deux
niveaux d'accès, selon les identifiants utilisés pour se connecter :

- **Super-administrateur** (vous, via `ADMIN_USER`/`ADMIN_PASSWORD`) : voit tous les marchands dans un
  sélecteur en haut de la page, peut en créer de nouveaux, et gère les identifiants de connexion de
  chacun depuis l'onglet **Mon compte** — changer le nom d'utilisateur, définir un nouveau mot de passe,
  ou en générer un aléatoirement (typiquement quand un marchand vous contacte parce qu'il a oublié le
  sien).
- **Marchand** (via le nom d'utilisateur/mot de passe propres à ce marchand, créés par vous à son
  onboarding) : ne voit que ses propres données — aucune trace des autres marchands, même leur nom.
  Depuis l'onglet **Mon compte**, il peut changer lui-même son mot de passe (mais pas son nom
  d'utilisateur, réservé au super-administrateur).

Selon le type du marchand consulté, l'interface permet :

- **Catalogue & stock** (marchands catalogue) : voir et modifier articles, variantes, prix, stock réel
  et seuil d'alerte (surligné quand le stock est sous le seuil), ajouter/supprimer des articles ou des
  variantes. Une colonne **Stock virtuel** (lecture seule) montre en plus le stock réel moins ce qui est
  déjà engagé dans des commandes Confirmée/Expédiée — c'est cette valeur, pas le stock réel brut, que le
  bot vérifie avant de proposer un article à un client.
- **Commandes** (marchands catalogue) : voir toutes les commandes reçues (avec le nombre total d'articles
  commandés dans une colonne dédiée) et changer leur statut (Nouvelle/Confirmée/Expédiée/Livrée/Annulée),
  avec raison d'annulation.
- **Services** (marchands service) : voir et modifier la liste des services (nom, durée, prix).
- **Rendez-vous** (marchands service) : voir tous les rendez-vous et changer leur statut
  (Nouvelle/Confirmé/Honoré/Absent/Annulé), avec raison d'annulation.
- **Conversations** (les deux types) : les clients qui ont demandé à parler à un humain, avec l'historique
  récent et une zone pour répondre manuellement (voir section suivante).
- **Paramètres** : message de confirmation automatique (les deux types), et pour un marchand service,
  en plus la durée des créneaux et les horaires d'ouverture par jour de la semaine.
- **Mon compte** : gestion des identifiants de connexion et du numéro de notification personnel (voir
  ci-dessus et section suivante).

## Mise en relation avec un humain

Un client peut à tout moment demander à parler à quelqu'un ("je veux parler à un vendeur", "un conseiller",
"un humain"...) — reconnu quel que soit le point où il en est dans sa commande ou sa prise de rendez-vous.

Dès que c'est détecté : le bot envoie une fois un message d'attente ("Je vous mets en relation avec un
membre de notre équipe...") puis reste silencieux sur les messages suivants de ce client — ils sont quand
même enregistrés et visibles dans l'onglet **Conversations** de `/admin`. Si un numéro de notification
personnel est configuré pour ce marchand (onglet **Mon compte**), le bot lui envoie directement un message
WhatsApp signalant la demande.

Le marchand répond alors depuis l'onglet Conversations (zone de texte + bouton Envoyer) — le message part
via le même compte WhatsApp API que le bot, puisque le numéro business ne peut plus être utilisé avec
l'appli WhatsApp classique une fois branché à l'API Cloud (limitation imposée par Meta, pas par
IzyVendeur). Chaque réponse manuelle remet à zéro un délai de 10 minutes ; si personne ne répond dans ce
délai, le bot reprend automatiquement la main dès le message suivant du client — sans action requise.

Cet état (qui est en pause, depuis quand, l'historique) est gardé en mémoire comme les conversations en
cours elles-mêmes : un redémarrage du serveur remet les compteurs à zéro, un compromis accepté pour
l'instant (voir la section précédente sur la persistance des données).

## Alertes WhatsApp envoyées au marchand

Si un numéro de notification personnel est configuré pour un marchand (onglet **Mon compte**), le bot lui
envoie directement un message WhatsApp dans deux situations :

- **Un client demande à parler à un humain** (voir section précédente).
- **Un client confirme une commande** (marchands catalogue uniquement) — dès qu'il répond "oui" au
  récapitulatif envoyé par le bot, donc juste après le passage automatique de la commande au statut
  Confirmée. Une commande "Nouvelle" pas encore confirmée par le client ne déclenche PAS d'alerte, pour
  éviter de notifier le marchand pour des paniers abandonnés.

### Le mécanisme des templates (fenêtre des 24h)

WhatsApp interdit d'envoyer un message texte libre à un numéro qui ne vous a pas écrit dans les 24 heures
précédentes ("fenêtre de conversation"). Concrètement, si le numéro de notification personnel d'un
marchand n'a pas lui-même envoyé de message à son bot récemment, ces alertes seraient bloquées par Meta.

Pour éviter cette contrainte, IzyVendeur essaie d'abord d'envoyer chaque alerte via un **template WhatsApp
pré-approuvé par Meta** (les templates peuvent être envoyés à tout moment, même en dehors de la fenêtre de
24h) — et ne bascule sur le texte libre (donc soumis à la fenêtre de 24h) que si l'envoi du template
échoue, par exemple parce qu'il n'a pas encore été approuvé.

**Ces templates doivent être créés une seule fois par vous, dans le WhatsApp Manager de Meta** ("Comptes
professionnels WhatsApp" → votre compte → **Modèles de messages** → **Créer un modèle**), avec exactement
ces réglages pour chacun (le nom et la langue doivent correspondre EXACTEMENT à ceux définis dans
`server.js`, sans quoi IzyVendeur ne les trouvera pas et basculera silencieusement sur le texte libre) :

**Template "un client veut parler à un humain"**

| Champ | Valeur |
|---|---|
| Nom | `izyvendeur_alerte_humain` |
| Catégorie | Utilitaire (*Utility*) |
| Langue | Français |
| Corps du message | `Bonjour, un client ({{1}}) souhaite être mis en relation avec un conseiller sur WhatsApp. Message du client : {{2}}. Connectez-vous à votre interface IzyVendeur (onglet Conversations) pour lui répondre.` |
| Exemple pour {{1}} | `237670001122` |
| Exemple pour {{2}} | `Je voudrais annuler ma commande` |

**Template "commande confirmée"**

| Champ | Valeur |
|---|---|
| Nom | `izyvendeur_alerte_commande` |
| Catégorie | Utilitaire (*Utility*) |
| Langue | Français |
| Corps du message | `Nouvelle commande confirmée {{1}} : {{2}}. Total : {{3}}. Téléphone client : {{4}}. Livraison : {{5}}. Consultez /admin, onglet Commandes, pour la traiter.` |
| Exemple pour {{1}} | `CMD-0007` |
| Exemple pour {{2}} | `Robe Rouge M x2, Sac Noir x1` |
| Exemple pour {{3}} | `38 000 FCFA` |
| Exemple pour {{4}} | `237670001122` |
| Exemple pour {{5}} | `Bonapriso, Douala` |

Pas de bouton, pas d'en-tête, pas de pied de page nécessaires pour aucun des deux. Une fois soumis,
l'approbation par Meta est généralement automatique et prend de quelques minutes à quelques heures
(rarement jusqu'à 24h) ; en cas de rejet, Meta indique la raison précise (catégorie, formulation, etc.) et
il suffit de corriger puis resoumettre.

Tant qu'un template n'est pas encore approuvé, l'alerte correspondante continue de fonctionner normalement
via le texte libre — à condition, comme avant, que le numéro de notification ait écrit au bot dans les
24h. Une fois un template approuvé, plus besoin de cette précaution pour cette alerte : ce sera automatique
dès le prochain message déclenchant une alerte de ce type, sans rien à changer côté code ou configuration.

## Protections contre les abus

Comme n'importe quel numéro WhatsApp peut écrire au bot, quelques protections évitent qu'une personne
mal intentionnée puisse s'en servir pour nuire au service ou à vos clients :

- **`/admin` et toute l'API protégées par mot de passe**, avec un accès strictement limité à ses propres
  données pour chaque marchand (voir section précédente) — car elles affichent les téléphones, adresses
  et noms de ses clients.
- **Mots de passe des marchands stockés hashés** (bcrypt) en base, jamais en clair — seul le mot de passe
  du super-administrateur reste une variable d'environnement (récupérable directement depuis Render en
  cas d'oubli, sans dépendre d'une fonctionnalité de récupération dans l'application).
- **Tout texte tapé par un client est affiché de façon sûre** (pas d'insertion HTML brute), pour empêcher
  qu'une "adresse" ou un "nom" contenant du code puisse s'exécuter dans votre navigateur.
- **Un même numéro WhatsApp ne peut pas créer plus de 3 commandes (ou rendez-vous) non confirmé(e)s en 2
  heures** — au-delà, le bot demande de confirmer ou traiter les précédent(e)s avant d'en accepter un(e)
  nouveau/nouvelle, pour éviter qu'on remplisse votre back-office de faux enregistrements.
- **L'adresse de livraison est limitée à 200 caractères** (et le nom de rendez-vous à 80) pour éviter les
  messages-fleuves.
- **Un rendez-vous "Nouvelle" (pas encore confirmé) bloque déjà le créneau**, pour empêcher que deux
  clients réservent la même place avant que le premier n'ait répondu.
- **Le bot répond toujours quelque chose**, même à un message qu'il ne comprend pas (photo, audio,
  texte incompréhensible) — plutôt que de rester silencieux, ce qui pourrait ressembler à une panne.

## Et après ?

- **Onboarding en libre-service** : construire un flux "Embedded Signup" pour que chaque nouveau marchand
  connecte lui-même son numéro WhatsApp, sans que vous ayez à l'ajouter manuellement depuis `/admin`.
- **Récupération de mot de passe par email** : aujourd'hui, un marchand qui oublie son mot de passe vous
  contacte et vous le réinitialisez depuis `/admin` (onglet Mon compte du marchand concerné) — un lien de
  réinitialisation envoyé automatiquement par email est envisageable plus tard, mais nécessite de
  connecter un service d'envoi d'email (ex: Resend, SendGrid) et de stocker l'adresse email de chaque
  marchand.
