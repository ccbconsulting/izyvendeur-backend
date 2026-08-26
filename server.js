// IzyVendeur - Backend minimal (preuve de concept)
// Ce serveur fait 2 choses :
//   1) Repond a la verification du webhook demandee par Meta (requete GET).
//   2) Recoit les messages WhatsApp entrants (requete POST) et renvoie une reponse automatique simple.
//
// Une fois deploye avec une adresse publique HTTPS (ex: https://xxxx.onrender.com),
// on branche cette adresse + "/webhook" dans le tableau de bord Meta (Etape 2 > Configurer des webhooks).

require("dotenv").config();
const express = require("express");
const conversation = require("./conversation");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_API_VERSION = "v21.0";

// --- Verification simple pour savoir si le serveur tourne (utile pour Render + pour vous) ---
app.get("/", (req, res) => {
  res.send("IzyVendeur backend : en ligne. Le webhook est sur /webhook. Les commandes recues sont visibles sur /commandes.");
});

// --- Page simple pour voir les commandes generees par le moteur de conversation ---
// (en attendant un vrai tableau de bord connecte au meme serveur)
app.get("/commandes", (req, res) => {
  const orders = conversation.getOrders().slice().reverse();
  const lignes = orders.map((o) => {
    const articles = (o.items || [])
      .map((it) => it.produit + " (" + it.couleur + " " + it.taille + ") x" + it.quantite)
      .join("<br/>");
    return (
      "<tr><td>CMD-" + String(o.id).padStart(4, "0") + "</td>" +
      "<td>" + new Date(o.dateISO).toLocaleString("fr-FR") + "</td>" +
      "<td>" + articles + "</td>" +
      "<td>" + (o.prix || 0).toLocaleString("fr-FR") + " FCFA</td>" +
      "<td>" + (o.telephone || "") + "</td>" +
      "<td>" + (o.adresse || "") + "</td>" +
      "<td>" + o.statut + "</td></tr>"
    );
  }).join("");
  res.send(
    "<html><head><meta charset='utf-8'><title>Commandes IzyVendeur</title>" +
    "<style>body{font-family:sans-serif;padding:20px;} table{border-collapse:collapse;width:100%;} " +
    "td,th{border:1px solid #ccc;padding:8px;text-align:left;font-size:14px;} th{background:#f2f2f2;}</style>" +
    "</head><body><h2>Commandes reçues (" + orders.length + ")</h2>" +
    "<table><tr><th>N°</th><th>Date</th><th>Articles</th><th>Total</th><th>Téléphone</th><th>Adresse</th><th>Statut</th></tr>" +
    (lignes || "<tr><td colspan='7'>Aucune commande pour l'instant.</td></tr>") +
    "</table></body></html>"
  );
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

    if (!texteRecu) {
      // Message sans texte (image, audio, etc.) : le moteur actuel ne sait traiter que du texte.
      console.log(`Message non-texte recu de ${from} (type: ${message.type}) — ignore pour l'instant.`);
      return;
    }

    console.log(`Message recu de ${from} : "${texteRecu}"`);

    // --- Vraie logique de conversation IzyVendeur (catalogue, stock, panier, commande) ---
    const reponse = conversation.handleMessage(from, texteRecu);

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

// On attend que l'etat (catalogue + commandes) soit charge - depuis PostgreSQL en production,
// depuis data.json en local - avant d'accepter la moindre requete. Voir conversation.js / db.js.
async function demarrer() {
  await conversation.init();
  app.listen(PORT, () => {
    console.log(`Serveur IzyVendeur demarre sur le port ${PORT}`);
  });
}

demarrer().catch((erreur) => {
  console.error("Echec du demarrage du serveur :", erreur);
  process.exit(1);
});
