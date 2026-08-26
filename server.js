// IzyVendeur - Backend minimal (preuve de concept)
// Ce serveur fait 2 choses :
//   1) Repond a la verification du webhook demandee par Meta (requete GET).
//   2) Recoit les messages WhatsApp entrants (requete POST) et renvoie une reponse automatique simple.
//
// Une fois deploye avec une adresse publique HTTPS (ex: https://xxxx.onrender.com),
// on branche cette adresse + "/webhook" dans le tableau de bord Meta (Etape 2 > Configurer des webhooks).

require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_API_VERSION = "v21.0";

// --- Verification simple pour savoir si le serveur tourne (utile pour Render + pour vous) ---
app.get("/", (req, res) => {
  res.send("IzyVendeur backend : en ligne. Le webhook est sur /webhook.");
});

// --- ETAPE 1 : Verification du webhook par Meta ---
// Quand vous collez l'URL + le token dans le tableau de bord Meta et cliquez "Verifier et enregistrer",
// Meta envoie une requete GET avec 3 parametres. Il faut renvoyer EXACTEMENT le "challenge" recu,
// mais seulement si le token recu correspond bien a celui que vous avez configure.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const tokenRecu = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && tokenRecu === VERIFY_TOKEN) {
    console.log("Webhook verifie avec succes par Meta.");
    res.status(200).send(challenge);
  } else {
    console.warn("Echec de verification webhook (token invalide ou mode incorrect).");
    res.sendStatus(403);
  }
});

// --- ETAPE 2 : Reception des messages entrants ---
// Meta envoie une requete POST a chaque fois qu'un client ecrit au numero WhatsApp,
// ou qu'un statut de message change (envoye/livre/lu).
app.post("/webhook", async (req, res) => {
  // On repond tout de suite 200 a Meta pour accuser reception (sinon Meta reessaie / se plaint).
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      // Ce n'est pas un nouveau message (ex: juste une mise a jour de statut) -> rien a faire.
      return;
    }

    const message = messages[0];
    const from = message.from; // numero du client, format international sans "+"
    const texteRecu = message.text?.body || "";

    console.log(`Message recu de ${from} : "${texteRecu}"`);

    // --- Reponse automatique simple (a remplacer plus tard par la vraie logique du simulateur) ---
    const reponse =
      "Merci pour votre message ! Ceci est une reponse automatique de test IzyVendeur. " +
      "Un vendeur va bientot connecter la vraie logique (catalogue, stock, commande) ici.";

    await envoyerMessageWhatsApp(from, reponse);
  } catch (erreur) {
    console.error("Erreur lors du traitement du webhook :", erreur);
  }
});

// --- Fonction utilitaire : envoyer un message texte via l'API WhatsApp Cloud ---
async function envoyerMessageWhatsApp(destinataire, texte) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error("WHATSAPP_TOKEN ou PHONE_NUMBER_ID manquant dans les variables d'environnement.");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const reponse = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: destinataire,
      type: "text",
      text: { body: texte },
    }),
  });

  if (!reponse.ok) {
    const detail = await reponse.text();
    console.error(`Echec de l'envoi WhatsApp (${reponse.status}) :`, detail);
  } else {
    console.log("Reponse envoyee avec succes.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur IzyVendeur demarre sur le port ${PORT}`);
});
