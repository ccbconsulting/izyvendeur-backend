# IzyVendeur — Backend (preuve de concept)

Petit serveur qui reçoit les messages WhatsApp (via le webhook Meta) et répond automatiquement.
C'est la pièce qui manquait au prototype IzyVendeur pour recevoir de vrais messages clients.

## Déploiement sur Render.com (gratuit pour démarrer)

### 1. Mettre le code sur GitHub

1. Créez un compte sur [github.com](https://github.com) si vous n'en avez pas.
2. Créez un nouveau dépôt (bouton vert "New").
3. Uploadez-y tous les fichiers de ce dossier (`server.js`, `package.json`, `.gitignore`, `.env.example`, `README.md`) — utilisez le bouton "Add file > Upload files" sur la page du dépôt, glissez les fichiers, puis "Commit changes".
   - Ne mettez jamais le fichier `.env` (avec vos vrais secrets) sur GitHub — le `.gitignore` fourni l'exclut automatiquement si vous utilisez git en ligne de commande.

### 2. Créer le service sur Render

1. Allez sur [render.com](https://render.com) et créez un compte (vous pouvez vous inscrire avec votre compte GitHub, c'est plus simple).
2. Cliquez "New +" > "Web Service".
3. Connectez votre dépôt GitHub (celui créé à l'étape 1).
4. Réglages du service :
   - **Name** : `izyvendeur-backend` (ou ce que vous voulez)
   - **Region** : la plus proche (Europe si disponible)
   - **Branch** : `main`
   - **Runtime** : Node
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
5. Dans la section **Environment Variables**, ajoutez ces 3 variables (les mêmes que dans `.env.example`) :
   - `VERIFY_TOKEN` → inventez une chaîne secrète (ex: `izyvendeur-2026-secret`), notez-la, vous en aurez besoin juste après.
   - `WHATSAPP_TOKEN` → le token d'accès **permanent** généré via Utilisateur Système (Business Settings > System Users). Pas le token temporaire de 24h.
   - `PHONE_NUMBER_ID` → le Phone Number ID de votre VRAI numéro (visible dans WhatsApp Manager > Numéros de téléphone > roue crantée, ou dans l'API Setup), pas celui du numéro de test.
6. Cliquez "Create Web Service". Render va installer et démarrer le serveur (2-3 minutes).
7. Une fois déployé, Render vous donne une adresse du type : `https://izyvendeur-backend.onrender.com`

### 3. Brancher l'adresse dans Meta

1. Retournez dans le tableau de bord Meta for Developers > votre app > cas d'utilisation WhatsApp > Étape 2 > "Configurer des webhooks".
2. **URL de rappel** : `https://izyvendeur-backend.onrender.com/webhook` (bien ajouter `/webhook` à la fin).
3. **Vérifier le token** : collez exactement la même valeur que celle mise dans `VERIFY_TOKEN` sur Render.
4. Cliquez "Vérifier et enregistrer". Si tout est correct, Meta valide instantanément (le serveur répond au défi de vérification).
5. Abonnez-vous au champ `messages` si Meta vous le demande (case à cocher séparée, souvent juste en dessous).

### 4. Tester en vrai

Envoyez un message WhatsApp depuis votre téléphone personnel vers votre numéro business. Vous devriez recevoir une réponse automatique de test en quelques secondes. Vous pouvez aussi surveiller les logs en direct dans l'onglet "Logs" de Render pour voir le message arriver côté serveur.

## Limite du plan gratuit Render à connaître

Le plan gratuit "s'endort" après 15 minutes sans trafic, et met quelques secondes à se réveiller au message suivant (léger délai la première fois). Pour un usage réel avec des clients, il faudra passer sur un plan payant (à partir de quelques dollars/mois) une fois qu'on avance vers la production — mais pour tester et développer, le gratuit suffit largement.

## Et après ?

Ce serveur ne fait qu'une réponse automatique générique pour l'instant. La prochaine étape sera d'y brancher la vraie logique du simulateur IzyVendeur (catalogue, vérification de stock, panier multi-articles, confirmation de commande) — actuellement dans le prototype HTML, elle devra être réécrite côté serveur avec une vraie base de données partagée entre tous les marchands.
