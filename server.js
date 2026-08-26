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

// --- Securite : echappement HTML ---
// Le telephone et l'adresse affiches sur /commandes viennent du TEXTE TAPE PAR LE CLIENT WhatsApp (pas
// du catalogue, controle par vous). Sans cet echappement, un client mal intentionne pourrait taper une
// "adresse" contenant du code HTML/JavaScript qui s'executerait dans votre navigateur des que vous
// ouvrez la page /commandes (faille XSS classique). On echappe systematiquement tout ce qui vient du
// client avant de l'inserer dans une page HTML.
function echapperHtml(valeur) {
  return String(valeur == null ? "" : valeur)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- Securite : protection de la page /commandes par mot de passe ---
// Cette page affiche les numeros de telephone et adresses de vos clients : elle ne doit pas etre
// consultable par n'importe qui tombant sur l'URL. Definissez ADMIN_USER et ADMIN_PASSWORD dans les
// variables d'environnement (Render > Environment) pour l'activer. Par securite, si ADMIN_PASSWORD
// n'est pas defini, l'acces est refuse plutot que laisse ouvert par defaut.
function protegerAcces(req, res, next) {
  const utilisateurAttendu = process.env.ADMIN_USER || "admin";
  const motDePasseAttendu = process.env.ADMIN_PASSWORD;

  if (!motDePasseAttendu) {
    res.status(503).send(
      "Tableau de bord protege : la variable d'environnement ADMIN_PASSWORD n'est pas configuree sur " +
      "Render. Ajoutez-la (Environment > Add Environment Variable) pour activer l'acces a cette page."
    );
    return;
  }

  const enTete = req.headers.authorization || "";
  const [schema, encode] = enTete.split(" ");
  if (schema === "Basic" && encode) {
    const decode = Buffer.from(encode, "base64").toString("utf8");
    const separateur = decode.indexOf(":");
    const utilisateur = decode.slice(0, separateur);
    const motDePasse = decode.slice(separateur + 1);
    if (utilisateur === utilisateurAttendu && motDePasse === motDePasseAttendu) {
      next();
      return;
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="IzyVendeur"');
  res.status(401).send("Authentification requise pour consulter cette page.");
}

// --- Verification simple pour savoir si le serveur tourne (utile pour Render + pour vous) ---
app.get("/", (req, res) => {
  res.send("IzyVendeur backend : en ligne. Le webhook est sur /webhook. Les commandes recues sont visibles sur /commandes.");
});

// --- Politique de confidentialite (URL publique requise par Meta pour la revue de l'application) ---
app.get("/politique-confidentialite", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>Politique de confidentialité — IzyVendeur</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #222; }
  h1 { font-size: 1.6em; }
  h2 { font-size: 1.2em; margin-top: 1.8em; }
  footer { margin-top: 3em; font-size: 0.9em; color: #666; }
</style>
</head>
<body>
<h1>Politique de confidentialité — IzyVendeur</h1>
<p><em>Dernière mise à jour : août 2026</em></p>

<p>IzyVendeur est un service édité par CCB CONSULTING SARL (Douala, Cameroun) qui permet à des
commerçants de recevoir et traiter automatiquement les commandes de leurs clients via WhatsApp. Cette
page explique quelles données sont traitées lorsque vous échangez avec un commerçant utilisant
IzyVendeur, et comment elles sont utilisées.</p>

<h2>Quelles données sont collectées</h2>
<p>Lorsque vous écrivez au numéro WhatsApp d'un commerçant utilisant IzyVendeur, nous traitons :
votre numéro de téléphone WhatsApp, le contenu des messages échangés (pour comprendre votre demande :
article, couleur, taille, quantité), et les informations que vous fournissez volontairement pour
finaliser une commande (adresse de livraison, numéro de contact).</p>

<h2>Pourquoi ces données sont traitées</h2>
<p>Ces informations servent uniquement à répondre à vos demandes, vérifier la disponibilité des
articles, créer et suivre votre commande, et vous transmettre les confirmations et informations de
livraison correspondantes, pour le compte du commerçant que vous avez contacté.</p>

<h2>Avec qui ces données sont partagées</h2>
<p>Vos données sont visibles par le commerçant à qui vous avez écrit (pour traiter votre commande) et
transitent par la plateforme WhatsApp Business (Meta) qui achemine les messages. Nous ne vendons ni ne
louons vos données à des tiers, et ne les partageons pas à des fins publicitaires.</p>

<h2>Combien de temps ces données sont conservées</h2>
<p>Les informations de commande sont conservées le temps nécessaire au traitement de votre commande et
au suivi du service après-vente, puis archivées ou supprimées selon les besoins légaux et opérationnels
du commerçant.</p>

<h2>Vos droits</h2>
<p>Vous pouvez à tout moment demander l'accès, la correction ou la suppression de vos données en nous
contactant à l'adresse ci-dessous.</p>

<h2>Contact</h2>
<p>CCB CONSULTING SARL — Douala, Cameroun<br/>
Email : info@ccbconsulting.org</p>

<footer>Cette politique peut être mise à jour périodiquement pour refléter l'évolution du service.</footer>
</body>
</html>`);
});

// --- Page simple pour voir les commandes generees par le moteur de conversation ---
// (en attendant un vrai tableau de bord connecte au meme serveur)
// Protegee par mot de passe (protegerAcces) car elle affiche les coordonnees de vos clients.
app.get("/commandes", protegerAcces, (req, res) => {
  const orders = conversation.getOrders().slice().reverse();
  const lignes = orders.map((o) => {
    const articles = (o.items || [])
      .map((it) => echapperHtml(it.produit) + " (" + echapperHtml(it.couleur) + " " + echapperHtml(it.taille) + ") x" + echapperHtml(it.quantite))
      .join("<br/>");
    return (
      "<tr><td>CMD-" + String(o.id).padStart(4, "0") + "</td>" +
      "<td>" + new Date(o.dateISO).toLocaleString("fr-FR") + "</td>" +
      "<td>" + articles + "</td>" +
      "<td>" + (o.prix || 0).toLocaleString("fr-FR") + " FCFA</td>" +
      "<td>" + echapperHtml(o.telephone) + "</td>" +
      "<td>" + echapperHtml(o.adresse) + "</td>" +
      "<td>" + echapperHtml(o.statut) + "</td></tr>"
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
      // Message sans texte (image, audio, document, sticker, localisation...) : le moteur actuel ne
      // sait traiter que du texte. On repond quand meme quelque chose plutot que de rester
      // completement silencieux (un silence total ressemble a une panne, meme si ce n'en est pas une).
      console.log(`Message non-texte recu de ${from} (type: ${message.type}) — reponse d'orientation envoyee.`);
      await envoyerMessageWhatsApp(
        from,
        "Je ne peux lire que du texte pour l'instant 🙏 Merci de m'écrire votre demande en quelques mots (ex : « Sac noir »)."
      );
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
