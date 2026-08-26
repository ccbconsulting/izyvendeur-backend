# IzyVendeur — Backend (preuve de concept)

Petit serveur qui reçoit les messages WhatsApp (via le webhook Meta) et répond automatiquement.
C'est la pièce qui manquait au prototype IzyVendeur pour recevoir de vrais messages clients.

## Déploiement sur Render.com (gratuit pour démarrer)

### 1. Mettre le code sur GitHub

1. Créez un compte sur [github.com](https://github.com) si vous n'en avez pas.
2. Créez un nouveau dépôt (bouton vert "New").
3. Uploadez-y tous les fichiers de ce dossier (`server.js`, `db.js`, `conversation.js`, `catalog.js`, `package.json`, `.gitignore`, `.env.example`, `README.md`) — utilisez le bouton "Add file > Upload files" sur la page du dépôt, glissez les fichiers, puis "Commit changes".
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
   - `WHATSAPP_TOKEN` → le token d'accès **permanent** généré via Utilisateur Système (Business Settings > System Users). Pas le token temporaire de 24h.
   - `PHONE_NUMBER_ID` → le Phone Number ID de votre VRAI numéro (visible dans WhatsApp Manager > Numéros de téléphone > roue crantée, ou dans l'API Setup), pas celui du numéro de test.
   - `DATABASE_URL` → collez l'"Internal Database URL" copiée à l'étape 2.
   - `ADMIN_USER` → un nom d'utilisateur pour protéger la page `/commandes` (ex : `admin`).
   - `ADMIN_PASSWORD` → un mot de passe de votre choix, connu de vous seul. **Sans cette variable, la
     page `/commandes` refuse l'accès** (par sécurité — elle affiche les téléphones et adresses de vos
     clients, elle ne doit pas être ouverte à n'importe qui tombant sur l'URL).
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

## La logique de conversation (catalogue, stock, panier, commande)

Le serveur ne se contente plus d'une réponse générique : il reprend exactement la logique du prototype
(fichier `conversation.js`, avec le catalogue de départ dans `catalog.js`).

- Chaque client (identifié par son numéro WhatsApp) a sa propre conversation en cours, donc plusieurs
  clients peuvent discuter en même temps sans se mélanger.
- Le moteur reconnaît l'article, la couleur et la taille demandés en cherchant dans le catalogue — pas
  de dictionnaire à maintenir à la main, tout nouvel article du catalogue est reconnu automatiquement.
- Le stock "virtuel" (stock réel moins ce qui est déjà réservé par des commandes Confirmée/Expédiée) est
  vérifié avant de proposer l'article.
- Le client peut ajouter plusieurs articles dans son panier avant de passer à la livraison.
- Une fois le numéro et l'adresse de livraison reçus, une vraie commande est créée (visible sur
  `/commandes`, une page simple listant toutes les commandes reçues).
- Si le client confirme, le message de confirmation automatique (personnalisable dans `catalog.js` via
  `DEFAULT_AUTO_CONFIRM_MESSAGE`) est envoyé et la commande passe au statut "Confirmée".

**Où sont sauvegardées les données ?** Dans une vraie base de données PostgreSQL (fichier `db.js`),
tant que la variable `DATABASE_URL` est configurée (voir étape 2) — catalogue et commandes survivent
maintenant aussi bien à la mise en veille/réveil du plan gratuit Render qu'aux redéploiements (upload de
fichiers modifiés) : plus rien n'est perdu. Si `DATABASE_URL` n'est pas définie (par exemple en test
local sans base installée), le serveur retombe automatiquement sur un fichier `data.json` local, comme
avant. Les conversations en cours (à quelle étape en est chaque client) restent, elles, uniquement en
mémoire : si le serveur redémarre en plein milieu d'une commande, le client devra reformuler sa demande
depuis le début — ça reste un comportement acceptable pour cette étape.

## Protections contre les abus

Comme n'importe quel numéro WhatsApp peut écrire au bot, quelques protections évitent qu'une personne
mal intentionnée puisse s'en servir pour nuire au service ou à vos clients :

- **Page `/commandes` protégée par mot de passe** (`ADMIN_USER` / `ADMIN_PASSWORD`) car elle affiche les
  téléphones et adresses de vos clients.
- **Tout texte tapé par un client est échappé avant d'être affiché** sur `/commandes`, pour empêcher
  qu'une "adresse" contenant du code puisse s'exécuter dans votre navigateur.
- **Un même numéro WhatsApp ne peut pas créer plus de 3 commandes non confirmées en 2 heures** — au-delà,
  le bot demande de confirmer ou traiter les précédentes avant d'en accepter une nouvelle, pour éviter
  qu'on remplisse votre page Commandes de fausses commandes.
- **L'adresse de livraison est limitée à 200 caractères** pour éviter les messages-fleuves.
- **Le bot répond toujours quelque chose**, même à un message qu'il ne comprend pas (photo, audio,
  texte incompréhensible) — plutôt que de rester silencieux, ce qui pourrait ressembler à une panne.

## Et après ?

- **Multi-marchands** : une fois "Fournisseur de technologie" validé côté Meta, utiliser l'"Embedded
  Signup" pour que chaque marchand connecte son propre numéro WhatsApp. Côté base de données, `db.js` est
  déjà structuré pour ça (une ligne par marchand, identifiée par une clé) — il restera à faire
  correspondre chaque message entrant (via son `phone_number_id`) au bon marchand plutôt qu'au marchand
  unique `"default"` codé en dur aujourd'hui.
- **Back-office connecté** : brancher les vues Catalogue / Commandes / Rapports du prototype HTML sur ce
  même serveur (au lieu du `localStorage` du navigateur), pour que le marchand gère son stock et ses
  commandes en temps réel.
