// IzyVendeur - Backend (multi-marchand)
//
// Ce serveur fait 3 choses :
//   1) Repond a la verification du webhook demandee par Meta (requete GET).
//   2) Recoit les messages WhatsApp entrants (requete POST), determine a QUEL marchand ils appartiennent
//      (via le phone_number_id que Meta indique toujours dans la charge utile) et les fait traiter par le
//      moteur de conversation de ce marchand (catalogue ou service, selon son type).
//   3) Expose une interface d'administration connectee (page /admin + API /api/...) pour consulter et
//      gerer le catalogue/stock/commandes (marchand catalogue) ou les services/rendez-vous (marchand
//      service) de chaque marchand, a la place de l'ancienne page /commandes en lecture seule.

require("dotenv").config();
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("./db");
const createCatalogEngine = require("./conversation");
const createServiceEngine = require("./conversationService");

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_API_VERSION = "v21.0";

// ---------------- Registre des marchands + moteurs de conversation ----------------
// engines[merchantId] = { merchant, engine }  -- engine expose toujours handleMessage(fromPhone, texte),
// quel que soit son type (catalogue ou service), ce qui garde le webhook simple.
const engines = {};
const phoneNumberIndex = {}; // phone_number_id WhatsApp -> merchantId

async function chargerMarchands() {
  const marchands = await db.initRegistry();
  for (const m of marchands) {
    const engine = m.type === "service" ? createServiceEngine(m.id) : createCatalogEngine(m.id);
    await engine.init();
    engines[m.id] = { merchant: m, engine };
    if (m.phoneNumberId) phoneNumberIndex[m.phoneNumberId] = m.id;
    console.log("Marchand charge : " + m.id + " (" + m.type + ")" + (m.phoneNumberId ? " — numero " + m.phoneNumberId : " — AUCUN numero WhatsApp associe"));
  }
}

// --- Securite : protection des pages/API d'administration par mot de passe ---
// Deux roles possibles, determines a partir des identifiants Basic Auth fournis :
//   - "superadmin" : ADMIN_USER/ADMIN_PASSWORD (variables d'environnement Render, comme avant le
//     multi-marchand). C'est vous : acces a TOUS les marchands, creation de marchands, et gestion des
//     identifiants de chacun (creation, modification, reinitialisation apres oubli).
//   - "marchand" : les identifiants propres a UN marchand (adminUser/adminPassword stockes dans son
//     enregistrement). Acces limite aux donnees de ce marchand uniquement.
// Par securite, si ADMIN_PASSWORD n'est pas defini, l'acces est refuse plutot que laisse ouvert par
// defaut (personne ne pourrait alors se connecter, meme un marchand, tant que ce n'est pas corrige).
function motDePasseCorrespond(motDePasseFourni, motDePasseStocke) {
  if (!motDePasseStocke) return false;
  if (/^\$2[aby]\$/.test(motDePasseStocke)) {
    try { return bcrypt.compareSync(motDePasseFourni, motDePasseStocke); } catch (erreur) { return false; }
  }
  // Compatibilite avec d'anciens mots de passe enregistres avant l'introduction du hashage (ex: le
  // marchand "default" migre automatiquement depuis les variables d'environnement historiques).
  return motDePasseFourni === motDePasseStocke;
}

function protegerAcces(req, res, next) {
  const superUtilisateur = process.env.ADMIN_USER || "admin";
  const superMotDePasse = process.env.ADMIN_PASSWORD;

  if (!superMotDePasse) {
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

    if (utilisateur === superUtilisateur && motDePasse === superMotDePasse) {
      req.auth = { role: "superadmin", merchantId: null, adminUser: utilisateur };
      next();
      return;
    }

    for (const id of Object.keys(engines)) {
      const m = engines[id].merchant;
      if (m.adminUser && utilisateur === m.adminUser && motDePasseCorrespond(motDePasse, m.adminPassword)) {
        req.auth = { role: "marchand", merchantId: id, adminUser: utilisateur };
        next();
        return;
      }
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="IzyVendeur"');
  res.status(401).send("Authentification requise pour consulter cette page.");
}

// Verifie que l'utilisateur authentifie (req.auth) a le droit d'agir sur le marchand `id` : le
// super-administrateur peut toujours, un marchand uniquement sur lui-meme. Repond 403 sinon.
function verifierPortee(req, res, id) {
  if (req.auth.role === "superadmin" || req.auth.merchantId === id) return true;
  res.status(403).json({ erreur: "Accès non autorisé à ce marchand." });
  return false;
}

function getMarchandOu404(req, res) {
  const entry = engines[req.params.id];
  if (!entry) { res.status(404).json({ erreur: "Marchand inconnu : " + req.params.id }); return null; }
  return entry;
}

// Combine les deux verifications precedentes : utilisee par toutes les routes /api/:id/...
function getMarchandAutorise(req, res) {
  if (!verifierPortee(req, res, req.params.id)) return null;
  return getMarchandOu404(req, res);
}

function genererMotDePasseAleatoire() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // sans caracteres ambigus
  let mdp = "";
  for (let i = 0; i < 10; i++) mdp += alphabet[Math.floor(Math.random() * alphabet.length)];
  return mdp;
}

// --- Verification simple pour savoir si le serveur tourne (utile pour Render + pour vous) ---
app.get("/", (req, res) => {
  res.send("IzyVendeur backend : en ligne. Le webhook est sur /webhook. L'administration est sur /admin.");
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
commerçants de recevoir et traiter automatiquement les commandes ou les rendez-vous de leurs clients via
WhatsApp. Cette page explique quelles données sont traitées lorsque vous échangez avec un commerçant
utilisant IzyVendeur, et comment elles sont utilisées.</p>

<h2>Quelles données sont collectées</h2>
<p>Lorsque vous écrivez au numéro WhatsApp d'un commerçant utilisant IzyVendeur, nous traitons :
votre numéro de téléphone WhatsApp, le contenu des messages échangés (pour comprendre votre demande :
article/service, couleur, taille, quantité, jour et heure souhaités), et les informations que vous
fournissez volontairement pour finaliser une commande ou un rendez-vous (adresse de livraison, nom, numéro
de contact).</p>

<h2>Pourquoi ces données sont traitées</h2>
<p>Ces informations servent uniquement à répondre à vos demandes, vérifier la disponibilité des articles
ou des créneaux, créer et suivre votre commande ou rendez-vous, et vous transmettre les confirmations
correspondantes, pour le compte du commerçant que vous avez contacté.</p>

<h2>Avec qui ces données sont partagées</h2>
<p>Vos données sont visibles par le commerçant à qui vous avez écrit (pour traiter votre demande) et
transitent par la plateforme WhatsApp Business (Meta) qui achemine les messages. Nous ne vendons ni ne
louons vos données à des tiers, et ne les partageons pas à des fins publicitaires.</p>

<h2>Combien de temps ces données sont conservées</h2>
<p>Les informations sont conservées le temps nécessaire au traitement de votre commande ou rendez-vous et
au suivi du service après-vente, puis archivées ou supprimées selon les besoins légaux et opérationnels du
commerçant.</p>

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

// --- Ancienne page /commandes : redirigee vers la nouvelle interface d'administration ---
app.get("/commandes", (req, res) => res.redirect("/admin"));

// --- Interface d'administration connectee ---
app.get("/admin", protegerAcces, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ---------------- API d'administration (protegee) ----------------

// Le super-administrateur voit tous les marchands ; un marchand ne voit que lui-meme (l'interface
// n'affiche donc jamais a un marchand la liste des autres marchands, meme leur nom).
app.get("/api/marchands", protegerAcces, (req, res) => {
  const tous = Object.values(engines).map((e) => ({
    id: e.merchant.id, nom: e.merchant.nom, type: e.merchant.type, adminUser: e.merchant.adminUser || null
  }));
  if (req.auth.role === "superadmin") return res.json(tous);
  res.json(tous.filter((m) => m.id === req.auth.merchantId));
});

// Ajoute un nouveau marchand (onboarding manuel : vous configurez son numero WhatsApp cote Meta a part,
// puis l'enregistrez ici avec le meme phone_number_id pour que le webhook sache lui router ses messages).
// Reserve au super-administrateur. adminUser/adminPassword sont les identifiants initiaux de connexion du
// marchand a /admin ; le mot de passe est hashe avant stockage (le marchand pourra le changer lui-meme
// ensuite depuis l'onglet "Mon compte").
app.post("/api/marchands", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const { id, nom, type, phoneNumberId, adminUser, adminPassword } = req.body || {};
  if (!id || !nom || !type) return res.status(400).json({ erreur: "id, nom et type sont requis." });
  if (type !== "catalogue" && type !== "service") return res.status(400).json({ erreur: "type doit être 'catalogue' ou 'service'." });
  if (engines[id]) return res.status(409).json({ erreur: "Un marchand avec cet id existe déjà." });
  if (!adminUser || !adminPassword) return res.status(400).json({ erreur: "adminUser et adminPassword sont requis pour créer les identifiants de connexion du marchand." });
  const merchant = {
    id, nom, type,
    phoneNumberId: phoneNumberId || null,
    adminUser,
    adminPassword: bcrypt.hashSync(String(adminPassword), 10)
  };
  await db.addMerchant(merchant);
  const engine = type === "service" ? createServiceEngine(id) : createCatalogEngine(id);
  await engine.init();
  engines[id] = { merchant, engine };
  if (merchant.phoneNumberId) phoneNumberIndex[merchant.phoneNumberId] = id;
  console.log("Nouveau marchand ajoute via l'API : " + id + " (" + type + ")");
  res.status(201).json({ id: merchant.id, nom: merchant.nom, type: merchant.type, adminUser: merchant.adminUser });
});

// Qui suis-je ? Utilise par l'interface d'administration pour savoir si l'utilisateur connecte est le
// super-administrateur (acces a tout, gestion des marchands et de leurs identifiants) ou un marchand
// (limite a ses propres donnees, peut seulement changer son propre mot de passe).
app.get("/api/moi", protegerAcces, (req, res) => {
  res.json({ role: req.auth.role, merchantId: req.auth.merchantId, adminUser: req.auth.adminUser });
});

// Creation, modification ou reinitialisation des identifiants de connexion d'un marchand.
//   - Le super-administrateur peut le faire pour N'IMPORTE QUEL marchand (changer son nom d'utilisateur,
//     lui definir un nouveau mot de passe, ou lui en generer un aleatoirement) — utilise notamment quand un
//     marchand oublie son mot de passe et vous contacte pour le faire reinitialiser.
//   - Un marchand peut le faire UNIQUEMENT pour lui-meme, et UNIQUEMENT pour changer son propre mot de
//     passe (pas son nom d'utilisateur).
app.put("/api/:id/identifiants", protegerAcces, async (req, res) => {
  const id = req.params.id;
  if (!verifierPortee(req, res, id)) return;
  const entry = engines[id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + id });

  const { adminUser, newPassword, genererMotDePasse } = req.body || {};

  if (req.auth.role !== "superadmin" && adminUser !== undefined) {
    return res.status(403).json({ erreur: "Seul le super-administrateur peut changer le nom d'utilisateur." });
  }

  const patch = {};
  let motDePasseEnClair = null;

  if (adminUser) patch.adminUser = String(adminUser);

  if (genererMotDePasse) {
    motDePasseEnClair = genererMotDePasseAleatoire();
    patch.adminPassword = bcrypt.hashSync(motDePasseEnClair, 10);
  } else if (newPassword) {
    if (String(newPassword).length < 6) return res.status(400).json({ erreur: "Le mot de passe doit contenir au moins 6 caractères." });
    motDePasseEnClair = String(newPassword);
    patch.adminPassword = bcrypt.hashSync(motDePasseEnClair, 10);
  }

  if (!Object.keys(patch).length) return res.status(400).json({ erreur: "Rien à modifier." });

  const maj = await db.updateMerchantCreds(id, patch);
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });

  entry.merchant.adminUser = maj.adminUser;
  entry.merchant.adminPassword = maj.adminPassword;

  console.log("Identifiants mis a jour pour le marchand '" + id + "' par " + req.auth.role + " (" + req.auth.adminUser + ").");
  res.json({ id, adminUser: maj.adminUser, nouveauMotDePasse: motDePasseEnClair || undefined });
});

// -- Marchand catalogue --

app.get("/api/:id/catalogue", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.getCatalog());
});

app.put("/api/:id/catalogue", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const nouveau = entry.engine.updateCatalog(req.body);
  if (!nouveau) return res.status(400).json({ erreur: "Corps de requête invalide (tableau attendu)." });
  res.json(nouveau);
});

app.get("/api/:id/commandes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.getOrders());
});

app.put("/api/:id/commandes/:orderId/statut", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { statut, raisonAnnulation } = req.body || {};
  const order = entry.engine.updateOrderStatus(req.params.orderId, statut, raisonAnnulation);
  if (!order) return res.status(404).json({ erreur: "Commande introuvable." });
  res.json(order);
});

// -- Marchand service (prise de rendez-vous) --

app.get("/api/:id/services", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  res.json(entry.engine.getServices());
});

app.put("/api/:id/services", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const nouveau = entry.engine.updateServices(req.body);
  if (!nouveau) return res.status(400).json({ erreur: "Corps de requête invalide (tableau attendu)." });
  res.json(nouveau);
});

app.get("/api/:id/rendezvous", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  res.json(entry.engine.getAppointments());
});

app.put("/api/:id/rendezvous/:apptId/statut", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const { statut, raisonAnnulation } = req.body || {};
  const appt = entry.engine.updateAppointmentStatus(req.params.apptId, statut, raisonAnnulation);
  if (!appt) return res.status(404).json({ erreur: "Rendez-vous introuvable." });
  res.json(appt);
});

// -- Parametres : commun aux deux types (autoConfirmMessage, + horaires/dureeCreneauMinutes pour service) --

app.get("/api/:id/parametres", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  res.json(entry.engine.getSettings());
});

app.put("/api/:id/parametres", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  res.json(entry.engine.updateSettings(req.body || {}));
});

// ---------------- Webhook WhatsApp ----------------

// --- ETAPE 1 : Verification du webhook par Meta ---
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
app.post("/webhook", async (req, res) => {
  // On repond tout de suite 200 a Meta pour accuser reception (sinon Meta reessaie / se plaint).
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const phoneNumberId = value?.metadata?.phone_number_id;

    if (!messages || messages.length === 0) {
      // Ce n'est pas un nouveau message (ex: juste une mise a jour de statut) -> rien a faire.
      return;
    }

    const merchantId = phoneNumberId && phoneNumberIndex[phoneNumberId];
    const marchand = merchantId && engines[merchantId];
    if (!marchand) {
      console.warn("Message recu sur le phone_number_id " + phoneNumberId + ", qui n'est associe a AUCUN marchand connu. Message ignore.");
      return;
    }

    const message = messages[0];
    const from = message.from; // numero du client, format international sans "+"
    const texteRecu = message.text?.body || "";

    if (!texteRecu) {
      console.log(`[${merchantId}] Message non-texte recu de ${from} (type: ${message.type}) — reponse d'orientation envoyee.`);
      await envoyerMessageWhatsApp(
        from,
        "Je ne peux lire que du texte pour l'instant 🙏 Merci de m'écrire votre demande en quelques mots.",
        phoneNumberId
      );
      return;
    }

    console.log(`[${merchantId}] Message recu de ${from} : "${texteRecu}"`);

    const reponse = marchand.engine.handleMessage(from, texteRecu);

    await envoyerMessageWhatsApp(from, reponse, phoneNumberId);
  } catch (erreur) {
    console.error("Erreur lors du traitement du webhook :", erreur);
  }
});

// --- Fonction utilitaire : envoyer un message texte via l'API WhatsApp Cloud ---
async function envoyerMessageWhatsApp(destinataire, texte, phoneNumberId) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    console.error("WHATSAPP_TOKEN ou phone_number_id manquant — impossible d'envoyer la reponse.");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

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

// On attend que le registre des marchands + l'etat de chacun soient charges avant d'accepter la moindre
// requete. Voir chargerMarchands() / db.js.
async function demarrer() {
  await chargerMarchands();
  app.listen(PORT, () => {
    console.log(`Serveur IzyVendeur demarre sur le port ${PORT} (${Object.keys(engines).length} marchand(s) charge(s))`);
  });
}

demarrer().catch((erreur) => {
  console.error("Echec du demarrage du serveur :", erreur);
  process.exit(1);
});
