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
const multer = require("multer");
const db = require("./db");
const storage = require("./storage");
const sh = require("./shared");
const createCatalogEngine = require("./conversation");
const createServiceEngine = require("./conversationService");

const app = express();
app.use(express.json());

// Upload de photos d'articles : conserve le fichier en memoire (jamais sur disque, Render l'efface de
// toute facon a chaque redemarrage) le temps de le transferer vers R2 - voir storage.js. Une seule photo
// a la fois par requete, plafonnee a 5 Mo (alignee sur la limite WhatsApp), le reste de la validation
// (format d'image) se fait dans storage.js.
const uploadPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_API_VERSION = "v21.0";

// Message envoye a la place du bot quand un marchand est suspendu (ex: facture impayee) — volontairement
// neutre et poli : la cause reelle (interne, cote marchand) ne regarde pas le client, qui n'y est pour
// rien. Voir merchant.actif (registre des marchands) et la verification en tout debut du webhook.
const MESSAGE_SERVICE_SUSPENDU_FR =
  "Ce service est temporairement indisponible. Merci de réessayer un peu plus tard — nous nous excusons pour la gêne occasionnée 🙏";
const MESSAGE_SERVICE_SUSPENDU_EN =
  "This service is temporarily unavailable. Please try again later — we apologize for the inconvenience 🙏";

// Templates WhatsApp utilises pour notifier le marchand (demande d'humain, commande confirmee, ...). Un
// template (contrairement a un message texte libre) peut etre envoye a tout moment, meme si le numero de
// notification du marchand n'a pas ecrit au bot dans les 24 dernieres heures — c'est pour ca qu'on
// privilegie ce canal, avec un repli en texte libre si jamais le template n'est pas (encore) approuve par
// Meta. Voir le README pour la marche a suivre exacte de creation et d'approbation de ces templates dans
// le WhatsApp Manager de Meta — le nom et la langue doivent correspondre EXACTEMENT a ce qui a ete
// approuve la-bas. `texteLibreRepli(params)` construit le message de secours (texte libre, donc soumis a
// la fenetre de 24h) a partir des memes parametres que ceux envoyes au template.
const TEMPLATES_ALERTE_MARCHAND = {
  humain: {
    nom: "izyvendeur_alerte_humain",
    langue: "fr",
    // params: [telephoneClient, messageClient]
    texteLibreRepli: (params) =>
      "Un client (" + params[0] + ") souhaite parler à quelqu'un :\n« " + params[1] + " »\n\n" +
      "Répondez-lui depuis /admin, onglet Conversations."
  },
  commande_confirmee: {
    nom: "izyvendeur_alerte_commande",
    langue: "fr",
    // params: [reference, resumeArticles, total, telephoneClient, adresse]
    texteLibreRepli: (params) =>
      "Nouvelle commande confirmée " + params[0] + " :\n" + params[1] + "\nTotal : " + params[2] +
      "\nTéléphone client : " + params[3] + "\nLivraison : " + params[4] +
      "\n\nConsultez /admin, onglet Commandes, pour la traiter."
  },
  // NOUVEAU (volet service) : alerte le marchand des qu'un client confirme un rendez-vous, symetrique a
  // "commande_confirmee" cote catalogue. Necessite la creation ET l'approbation, cote Meta WhatsApp
  // Manager, d'un template nomme EXACTEMENT "izyvendeur_alerte_rdv" (langue fr) avec 6 variables dans cet
  // ordre - voir conversationService.js, notifierMarchand("rdv_confirme", [...]). Tant que ce template
  // n'est pas approuve, le repli en texte libre ci-dessous fonctionne uniquement dans la fenetre de 24h.
  rdv_confirme: {
    nom: "izyvendeur_alerte_rdv",
    langue: "fr",
    // params: [reference, serviceEtPraticien, creneauFormatte, prixFormatte, clientNom, telephoneClient]
    texteLibreRepli: (params) =>
      "Nouveau rendez-vous confirmé " + params[0] + " :\n" + params[1] + "\nCréneau : " + params[2] +
      "\nPrix : " + params[3] + "\nClient : " + params[4] + "\nTéléphone : " + params[5] +
      "\n\nConsultez /admin, onglet Rendez-vous, pour le suivre."
  }
};

// ---------------- Registre des marchands + moteurs de conversation ----------------
// engines[merchantId] = { merchant, engine }  -- engine expose toujours handleMessage(fromPhone, texte),
// quel que soit son type (catalogue ou service), ce qui garde le webhook simple.
const engines = {};
const phoneNumberIndex = {}; // phone_number_id WhatsApp -> merchantId

// Fournit a un moteur de conversation les fonctions dont il a besoin pour parler a WhatsApp lui-meme (au
// lieu de renvoyer simplement une reponse au webhook) : envoyer un message texte a N'IMPORTE QUEL numero
// (reponses manuelles du marchand a un client mis en pause), envoyer une photo d'article (voir
// storage.js), et notifier le numero de notification personnel du marchand (no-op si non configure).
// Toujours resolues au moment de l'appel via `engines[merchantKey]` pour rester a jour meme si le
// marchand change de numero/notification apres coup.
function creerOptionsEngine(merchantKey) {
  return {
    envoyer: async (destinataire, texte) => {
      const entry = engines[merchantKey];
      if (!entry) return;
      await envoyerMessageWhatsApp(destinataire, texte, entry.merchant.phoneNumberId);
    },
    envoyerImage: async (destinataire, urlImage, legende) => {
      const entry = engines[merchantKey];
      if (!entry) return;
      await envoyerImageWhatsApp(destinataire, urlImage, legende, entry.merchant.phoneNumberId);
    },
    // `typeAlerte` choisit le template (voir TEMPLATES_ALERTE_MARCHAND ci-dessus) ; `params` est la liste
    // de valeurs BRUTES (pas encore mises en forme) a inserer dans ses variables, dans l'ordre. C'est ici,
    // et seulement ici, qu'on sait s'il faut passer par un template ou par du texte libre de secours.
    notifierMarchand: async (typeAlerte, params) => {
      const entry = engines[merchantKey];
      if (!entry || !entry.merchant.phoneNotification) return;
      const config = TEMPLATES_ALERTE_MARCHAND[typeAlerte];
      if (!config) {
        console.error(`[${merchantKey}] Type d'alerte marchand inconnu : "${typeAlerte}".`);
        return;
      }
      const destinataire = entry.merchant.phoneNotification;
      const phoneNumberId = entry.merchant.phoneNumberId;
      const parametresNettoyes = params.map(nettoyerPourTemplate);

      const envoiTemplateReussi = await envoyerTemplateWhatsApp(
        destinataire,
        phoneNumberId,
        config.nom,
        config.langue,
        parametresNettoyes
      );

      if (!envoiTemplateReussi) {
        // Repli : texte libre, qui ne passera que si ce numero a deja ecrit au bot dans les 24h
        // (fenetre WhatsApp). Utile pendant que le template est en attente d'approbation par Meta, ou si
        // son nom/sa langue ne correspond pas exactement a ce qui est configure ci-dessus.
        console.warn(
          `[${merchantKey}] Repli en texte libre pour la notification marchand ` +
          `(le template "${config.nom}" a echoue ou n'est pas encore approuve).`
        );
        await envoyerMessageWhatsApp(destinataire, config.texteLibreRepli(params), phoneNumberId);
      }
    },
    // Enregistre durablement un message dans le journal complet des conversations (voir db.js) - alimente
    // l'onglet "Historique" de /admin. Ne leve jamais : une erreur ici ne doit jamais interrompre l'envoi
    // ou la reception d'un message WhatsApp, seulement priver cette conversation de son entree d'historique.
    journaliser: async (telephone, de, texte) => {
      try {
        await db.logConversationMessage(merchantKey, telephone, de, texte);
      } catch (erreur) {
        console.error(`[${merchantKey}] Echec de journalisation de la conversation :`, erreur);
      }
    }
  };
}

// Nettoie un texte pour qu'il respecte les contraintes de Meta sur les variables de template : pas de
// saut de ligne/tabulation, pas plus d'un espace consecutif, longueur raisonnable.
function nettoyerPourTemplate(texte) {
  return String(texte || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 300);
}

async function chargerMarchands() {
  const marchands = await db.initRegistry();
  for (const m of marchands) {
    const options = creerOptionsEngine(m.id);
    const engine = m.type === "service" ? createServiceEngine(m.id, options) : createCatalogEngine(m.id, options);
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

// Roles assignables a un compte "employe" d'un marchand (voir /api/:id/employes plus bas) — un employe
// peut cumuler plusieurs de ces roles. "catalogue" n'a de sens que pour un marchand de type catalogue,
// "rendezvous" que pour un marchand de type service ; "conversations" et "parametres" s'appliquent aux
// deux types. Le PROPRIETAIRE du marchand (role "marchand") et le super-administrateur ont eux toujours
// acces a tout ce qui concerne LEUR marchand, quels que soient ces roles - la restriction ne s'applique
// qu'aux employes.
const ROLES_EMPLOYE_VALIDES = ["catalogue", "rendezvous", "conversations", "parametres"];

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
      for (const emp of (m.employes || [])) {
        if (emp.identifiant && utilisateur === emp.identifiant && motDePasseCorrespond(motDePasse, emp.motDePasseHash)) {
          req.auth = { role: "employe", merchantId: id, adminUser: utilisateur, employeId: emp.id, roles: emp.roles || [] };
          next();
          return;
        }
      }
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="IzyVendeur"');
  res.status(401).send("Authentification requise pour consulter cette page.");
}

// Verifie que l'utilisateur authentifie (req.auth) a le droit d'agir sur le marchand `id` : le
// super-administrateur peut toujours, un marchand OU UN EMPLOYE uniquement sur le marchand auquel il
// appartient (la restriction plus fine par role d'un employe est verifiee separement, voir
// getMarchandAutorise ci-dessous). Repond 403 sinon.
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

// Combine les verifications precedentes, PLUS (nouveau) le controle d'acces par role d'un employe.
// `permission` est optionnel : un des ROLES_EMPLOYE_VALIDES, ou un tableau de plusieurs (acces accorde si
// l'employe a AU MOINS UN des roles listes) pour une route accessible via plusieurs roles differents (ex:
// le Simulateur WhatsApp, utile aussi bien a un employe "catalogue"/"rendezvous" qu'a un employe
// "conversations"). Omis (ou pour un role "marchand"/"superadmin") = aucune restriction supplementaire.
function getMarchandAutorise(req, res, permission) {
  if (!verifierPortee(req, res, req.params.id)) return null;
  if (permission && req.auth.role === "employe") {
    const permissionsAcceptees = Array.isArray(permission) ? permission : [permission];
    const aAcces = permissionsAcceptees.some((p) => (req.auth.roles || []).indexOf(p) !== -1);
    if (!aAcces) {
      res.status(403).json({ erreur: "Vous n'avez pas accès à cette fonctionnalité." });
      return null;
    }
  }
  return getMarchandOu404(req, res);
}

// true si l'utilisateur authentifie est le PROPRIETAIRE de ce marchand (role "marchand") ou le
// super-administrateur - utilise pour les actions reservees au proprietaire (gestion des employes,
// suspension, etc.) qu'un employe ne doit jamais pouvoir faire, quels que soient ses roles.
function estGestionnaireDuMarchand(req, id) {
  return req.auth.role === "superadmin" || (req.auth.role === "marchand" && req.auth.merchantId === id);
}

// true si cet identifiant est deja utilise par un compte existant (super-administrateur, marchand, ou
// employe de N'IMPORTE QUEL marchand) - la connexion (Basic Auth) etant globale au serveur (pas de "choix
// du marchand" prealable), deux comptes avec le meme identifiant seraient impossibles a distinguer a la
// connexion (le premier trouve gagnerait toujours). Verifie a la CREATION d'un employe pour eviter ce
// piege des le depart.
function identifiantDejaUtilise(identifiant) {
  const superUtilisateur = process.env.ADMIN_USER || "admin";
  if (identifiant === superUtilisateur) return true;
  for (const id of Object.keys(engines)) {
    const m = engines[id].merchant;
    if (m.adminUser === identifiant) return true;
    if ((m.employes || []).some((e) => e.identifiant === identifiant)) return true;
  }
  return false;
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
    id: e.merchant.id, nom: e.merchant.nom, type: e.merchant.type, adminUser: e.merchant.adminUser || null,
    phoneNotification: e.merchant.phoneNotification || null, actif: e.merchant.actif !== false
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
  const { id, nom, type, phoneNumberId, adminUser, adminPassword, phoneNotification } = req.body || {};
  if (!id || !nom || !type) return res.status(400).json({ erreur: "id, nom et type sont requis." });
  if (type !== "catalogue" && type !== "service") return res.status(400).json({ erreur: "type doit être 'catalogue' ou 'service'." });
  if (engines[id]) return res.status(409).json({ erreur: "Un marchand avec cet id existe déjà." });
  if (!adminUser || !adminPassword) return res.status(400).json({ erreur: "adminUser et adminPassword sont requis pour créer les identifiants de connexion du marchand." });
  const merchant = {
    id, nom, type,
    phoneNumberId: phoneNumberId || null,
    adminUser,
    adminPassword: bcrypt.hashSync(String(adminPassword), 10),
    phoneNotification: phoneNotification || null
  };
  await db.addMerchant(merchant);
  const options = creerOptionsEngine(id);
  const engine = type === "service" ? createServiceEngine(id, options) : createCatalogEngine(id, options);
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
  res.json({ role: req.auth.role, merchantId: req.auth.merchantId, adminUser: req.auth.adminUser, roles: req.auth.roles || null });
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
  // Ces identifiants sont ceux du PROPRIETAIRE du marchand (compte principal) — un employe a son propre
  // compte, gere via PUT /api/:id/employes/:employeId (voir plus bas), jamais celui-ci.
  if (req.auth.role === "employe") return res.status(403).json({ erreur: "Utilisez la gestion de votre compte employé pour changer votre mot de passe." });
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

  const maj = await db.updateMerchantFields(id, patch);
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });

  entry.merchant.adminUser = maj.adminUser;
  entry.merchant.adminPassword = maj.adminPassword;

  console.log("Identifiants mis a jour pour le marchand '" + id + "' par " + req.auth.role + " (" + req.auth.adminUser + ").");
  res.json({ id, adminUser: maj.adminUser, nouveauMotDePasse: motDePasseEnClair || undefined });
});

// ---------------- Employes d'un marchand (comptes a acces restreint a certaines taches) ----------------
// Un marchand peut creer, pour lui-meme, des comptes "employe" limites a certains onglets/actions (voir
// ROLES_EMPLOYE_VALIDES plus haut) — ex: une receptionniste qui ne gere que les rendez-vous et repond aux
// clients mis en relation avec un humain, sans jamais voir les parametres ni les chiffres. Creation,
// modification (nom/roles/mot de passe) et suppression reservees au PROPRIETAIRE du marchand et au
// super-administrateur (voir estGestionnaireDuMarchand) ; un employe ne peut jamais gerer d'autres
// employes, seulement changer son propre mot de passe (voir le PUT ci-dessous).

app.get("/api/:id/employes", protegerAcces, (req, res) => {
  const id = req.params.id;
  if (!verifierPortee(req, res, id)) return;
  if (!estGestionnaireDuMarchand(req, id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  res.json((entry.merchant.employes || []).map((e) => ({ id: e.id, nom: e.nom, identifiant: e.identifiant, roles: e.roles || [] })));
});

app.post("/api/:id/employes", protegerAcces, async (req, res) => {
  const id = req.params.id;
  if (!verifierPortee(req, res, id)) return;
  if (!estGestionnaireDuMarchand(req, id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  const entry = getMarchandOu404(req, res); if (!entry) return;

  const { nom, identifiant, motDePasse, roles } = req.body || {};
  if (!nom || !String(nom).trim()) return res.status(400).json({ erreur: "nom requis." });
  if (!identifiant || !String(identifiant).trim()) return res.status(400).json({ erreur: "identifiant requis." });
  if (!motDePasse || String(motDePasse).length < 6) return res.status(400).json({ erreur: "motDePasse requis (6 caractères minimum)." });

  const rolesDemandes = Array.isArray(roles) ? roles.filter((r) => ROLES_EMPLOYE_VALIDES.indexOf(r) !== -1) : [];
  if (!rolesDemandes.length) return res.status(400).json({ erreur: "Au moins un rôle est requis." });
  const rolesIncompatibles = rolesDemandes.filter((r) =>
    (r === "catalogue" && entry.engine.type !== "catalogue") || (r === "rendezvous" && entry.engine.type !== "service")
  );
  if (rolesIncompatibles.length) {
    return res.status(400).json({ erreur: "Rôle(s) non compatible(s) avec le type de ce marchand : " + rolesIncompatibles.join(", ") + "." });
  }

  const idNormalise = String(identifiant).trim();
  if (identifiantDejaUtilise(idNormalise)) {
    return res.status(409).json({ erreur: "Cet identifiant est déjà utilisé par un autre compte (marchand ou employé)." });
  }

  const employe = {
    id: "emp" + Date.now() + Math.floor(Math.random() * 1000),
    nom: String(nom).trim(),
    identifiant: idNormalise,
    motDePasseHash: bcrypt.hashSync(String(motDePasse), 10),
    roles: rolesDemandes
  };
  const ajoute = await db.addEmploye(id, employe);
  if (!ajoute) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.employes = entry.merchant.employes || [];
  entry.merchant.employes.push(employe);

  console.log(`[${id}] Nouvel employé créé par ${req.auth.adminUser} : ${employe.identifiant} (${employe.roles.join(", ")}).`);
  res.status(201).json({ id: employe.id, nom: employe.nom, identifiant: employe.identifiant, roles: employe.roles });
});

// Modifie un employe existant :
//   - Le proprietaire du marchand (ou le super-administrateur) peut changer son nom, ses roles, et/ou lui
//     definir un nouveau mot de passe (ou lui en generer un aleatoirement), exactement comme pour le
//     compte principal via PUT /api/:id/identifiants.
//   - Un employe peut le faire UNIQUEMENT pour lui-meme, et UNIQUEMENT pour changer son propre mot de
//     passe (jamais son nom ni ses roles).
app.put("/api/:id/employes/:employeId", protegerAcces, async (req, res) => {
  const id = req.params.id;
  const employeId = req.params.employeId;
  if (!verifierPortee(req, res, id)) return;
  const entry = getMarchandOu404(req, res); if (!entry) return;
  const employeActuel = (entry.merchant.employes || []).find((e) => e.id === employeId);
  if (!employeActuel) return res.status(404).json({ erreur: "Employé introuvable." });

  const patch = {};
  let motDePasseEnClair = null;

  if (req.auth.role === "employe") {
    if (req.auth.employeId !== employeId) return res.status(403).json({ erreur: "Vous ne pouvez modifier que votre propre compte." });
    if (req.body && (req.body.nom !== undefined || req.body.roles !== undefined)) {
      return res.status(403).json({ erreur: "Seul le propriétaire du marchand peut changer le nom ou les rôles d'un compte employé." });
    }
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ erreur: "Le mot de passe doit contenir au moins 6 caractères." });
    motDePasseEnClair = String(newPassword);
    patch.motDePasseHash = bcrypt.hashSync(motDePasseEnClair, 10);
  } else if (estGestionnaireDuMarchand(req, id)) {
    const { nom, roles, newPassword, genererMotDePasse } = req.body || {};
    if (nom !== undefined) {
      if (!String(nom).trim()) return res.status(400).json({ erreur: "Le nom ne peut pas être vide." });
      patch.nom = String(nom).trim();
    }
    if (roles !== undefined) {
      const rolesDemandes = Array.isArray(roles) ? roles.filter((r) => ROLES_EMPLOYE_VALIDES.indexOf(r) !== -1) : [];
      if (!rolesDemandes.length) return res.status(400).json({ erreur: "Au moins un rôle est requis." });
      const rolesIncompatibles = rolesDemandes.filter((r) =>
        (r === "catalogue" && entry.engine.type !== "catalogue") || (r === "rendezvous" && entry.engine.type !== "service")
      );
      if (rolesIncompatibles.length) {
        return res.status(400).json({ erreur: "Rôle(s) non compatible(s) avec le type de ce marchand : " + rolesIncompatibles.join(", ") + "." });
      }
      patch.roles = rolesDemandes;
    }
    if (genererMotDePasse) {
      motDePasseEnClair = genererMotDePasseAleatoire();
      patch.motDePasseHash = bcrypt.hashSync(motDePasseEnClair, 10);
    } else if (newPassword) {
      if (String(newPassword).length < 6) return res.status(400).json({ erreur: "Le mot de passe doit contenir au moins 6 caractères." });
      motDePasseEnClair = String(newPassword);
      patch.motDePasseHash = bcrypt.hashSync(motDePasseEnClair, 10);
    }
  } else {
    return res.status(403).json({ erreur: "Accès non autorisé." });
  }

  if (!Object.keys(patch).length) return res.status(400).json({ erreur: "Rien à modifier." });

  const maj = await db.updateEmploye(id, employeId, patch);
  if (!maj) return res.status(404).json({ erreur: "Employé introuvable." });
  Object.assign(employeActuel, maj);

  console.log(`[${id}] Compte employé '${employeId}' mis à jour par ${req.auth.adminUser}.`);
  res.json({ id: maj.id, nom: maj.nom, identifiant: maj.identifiant, roles: maj.roles, nouveauMotDePasse: motDePasseEnClair || undefined });
});

app.delete("/api/:id/employes/:employeId", protegerAcces, async (req, res) => {
  const id = req.params.id;
  if (!verifierPortee(req, res, id)) return;
  if (!estGestionnaireDuMarchand(req, id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  const supprime = await db.deleteEmploye(id, req.params.employeId);
  if (!supprime) return res.status(404).json({ erreur: "Employé introuvable." });
  entry.merchant.employes = (entry.merchant.employes || []).filter((e) => e.id !== req.params.employeId);
  console.log(`[${id}] Compte employé '${req.params.employeId}' supprimé par ${req.auth.adminUser}.`);
  res.json({ id: req.params.employeId, supprime: true });
});

// Suspension / reactivation d'un marchand (ex: facture impayee) — reserve au super-administrateur, un
// marchand ne doit evidemment jamais pouvoir se reactiver lui-meme. Un marchand suspendu voit son bot
// repondre uniquement le message poli d'indisponibilite (voir MESSAGE_SERVICE_SUSPENDU) a la place de tout
// traitement normal, jusqu'a reactivation ; rien d'autre n'est touche (catalogue, commandes, historique).
app.put("/api/:id/actif", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = engines[req.params.id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + req.params.id });
  const { actif } = req.body || {};
  if (typeof actif !== "boolean") return res.status(400).json({ erreur: "actif (booléen) est requis." });
  const maj = await db.updateMerchantFields(req.params.id, { actif });
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.actif = maj.actif;
  console.log(`[${req.params.id}] Marchand ${actif ? "réactivé" : "suspendu"} par ${req.auth.adminUser}.`);
  res.json({ id: req.params.id, actif: maj.actif });
});

// Corrige le nom affiche et/ou le phone_number_id WhatsApp d'un marchand DEJA CREE (ex: faute de frappe a
// la creation). Reserve au super-administrateur. Volontairement PAS "id" ni "type" ici — voir le
// commentaire de db.updateMerchantFields pour pourquoi ces deux champs-la ne sont jamais modifiables une
// fois le marchand cree (il faut alors supprimer et recreer, voir DELETE /api/marchands/:id ci-dessous).
app.put("/api/marchands/:id/infos", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = engines[req.params.id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + req.params.id });
  const { nom, phoneNumberId } = req.body || {};
  const patch = {};
  if (nom !== undefined) {
    if (!String(nom).trim()) return res.status(400).json({ erreur: "Le nom ne peut pas être vide." });
    patch.nom = String(nom).trim();
  }
  if (phoneNumberId !== undefined) patch.phoneNumberId = phoneNumberId ? String(phoneNumberId).trim() : null;
  if (!Object.keys(patch).length) return res.status(400).json({ erreur: "Rien à modifier." });

  const maj = await db.updateMerchantFields(req.params.id, patch);
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });

  // L'ancien phone_number_id (s'il y en avait un) doit être retiré de l'index de routage du webhook avant
  // que le nouveau y soit ajouté, sinon un message adressé a l'ancien numero resterait aussi route ici.
  if (entry.merchant.phoneNumberId && phoneNumberIndex[entry.merchant.phoneNumberId] === req.params.id) {
    delete phoneNumberIndex[entry.merchant.phoneNumberId];
  }
  entry.merchant.nom = maj.nom;
  entry.merchant.phoneNumberId = maj.phoneNumberId;
  if (maj.phoneNumberId) phoneNumberIndex[maj.phoneNumberId] = req.params.id;

  console.log(`[${req.params.id}] Informations du marchand mises à jour par ${req.auth.adminUser}.`);
  res.json({ id: req.params.id, nom: maj.nom, phoneNumberId: maj.phoneNumberId });
});

// Supprime DEFINITIVEMENT un marchand du registre (ex: cree par erreur avec un mauvais "id" ou un mauvais
// type — les deux seuls champs qu'on ne peut pas corriger via PUT /api/marchands/:id/infos ci-dessus, voir
// son commentaire). Reserve au super-administrateur. Ne supprime PAS son etat deja enregistre
// (catalogue/commandes ou services/rendez-vous) ni son journal de conversations — voir le commentaire de
// db.deleteMerchant : pour un marchand qui ne paie plus mais dont on veut garder l'historique, preferer la
// suspension (PUT /api/:id/actif) a cette suppression, irreversible pour la ligne du registre elle-meme.
app.delete("/api/marchands/:id", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const id = req.params.id;
  const entry = engines[id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + id });

  const supprime = await db.deleteMerchant(id);
  if (!supprime) return res.status(404).json({ erreur: "Marchand introuvable." });

  if (entry.merchant.phoneNumberId && phoneNumberIndex[entry.merchant.phoneNumberId] === id) {
    delete phoneNumberIndex[entry.merchant.phoneNumberId];
  }
  delete engines[id];

  console.log(`[${id}] Marchand supprimé du registre par ${req.auth.adminUser}.`);
  res.json({ id, supprime: true });
});

// -- Marchand catalogue -- (permission employe requise : "catalogue")

app.get("/api/:id/catalogue", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "catalogue"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.getCatalog());
});

app.put("/api/:id/catalogue", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "catalogue"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const nouveau = entry.engine.updateCatalog(req.body);
  if (!nouveau) return res.status(400).json({ erreur: "Corps de requête invalide (tableau attendu)." });
  res.json(nouveau);
});

// Photo d'un article : uploadee vers Cloudflare R2 (voir storage.js), puis son URL publique est ajoutee
// au tableau `photos` de l'article. La toute premiere photo d'un article est celle que le bot envoie au
// client des qu'il montre de l'interet (voir conversation.js, envoyerPhotoProduit) — pas besoin d'action
// supplementaire une fois la photo ajoutee ici.
app.post("/api/:id/catalogue/:productId/photos", protegerAcces, uploadPhoto.single("photo"), async (req, res) => {
  const entry = getMarchandAutorise(req, res, "catalogue"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!storage.estConfigure()) {
    return res.status(503).json({ erreur: "Hébergement des photos non configuré sur le serveur (variables R2_* manquantes sur Render). Voir le README, section « Photos des articles »." });
  }
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"photo\" requis)." });
  try {
    const url = await storage.uploaderPhotoProduit({
      merchantKey: req.params.id,
      productId: req.params.productId,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });
    const produit = entry.engine.ajouterPhotoProduit(req.params.productId, url);
    if (!produit) return res.status(404).json({ erreur: "Article introuvable." });
    res.status(201).json({ url, produit });
  } catch (erreur) {
    res.status(400).json({ erreur: erreur.message || "Échec de l'envoi de la photo." });
  }
});

app.delete("/api/:id/catalogue/:productId/photos", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "catalogue"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ erreur: "url requise." });
  const produit = entry.engine.supprimerPhotoProduit(req.params.productId, url);
  if (!produit) return res.status(404).json({ erreur: "Article introuvable." });
  await storage.supprimerPhotoProduit(url); // best-effort, ne bloque jamais la reponse
  res.json({ ok: true, produit });
});

// Permission "conversations", volontairement PAS "catalogue" : voir/traiter les commandes est rattache a
// qui parle aux clients (service client), pas a qui gere le stock/prix - un(e) gestionnaire de stock n'a
// pas besoin de voir les commandes, et quiconque a acces aux Conversations doit pouvoir les suivre.
app.get("/api/:id/commandes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "conversations"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.getOrders());
});

app.put("/api/:id/commandes/:orderId/statut", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "conversations"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { statut, raisonAnnulation } = req.body || {};
  const order = entry.engine.updateOrderStatus(req.params.orderId, statut, raisonAnnulation);
  if (!order) return res.status(404).json({ erreur: "Commande introuvable." });
  res.json(order);
});

// -- Marchand service (prise de rendez-vous) -- (permission employe requise : "rendezvous")

app.get("/api/:id/services", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  res.json(entry.engine.getServices());
});

app.put("/api/:id/services", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const nouveau = entry.engine.updateServices(req.body);
  if (!nouveau) return res.status(400).json({ erreur: "Corps de requête invalide (tableau attendu)." });
  res.json(nouveau);
});

app.get("/api/:id/rendezvous", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  res.json(entry.engine.getAppointments());
});

app.put("/api/:id/rendezvous/:apptId/statut", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const { statut, raisonAnnulation } = req.body || {};
  const appt = entry.engine.updateAppointmentStatus(req.params.apptId, statut, raisonAnnulation);
  if (!appt) return res.status(404).json({ erreur: "Rendez-vous introuvable." });
  res.json(appt);
});

// -- Parametres : commun aux deux types (autoConfirmMessage, + horaires/dureeCreneauMinutes pour service) --
// (permission employe requise : "parametres")

app.get("/api/:id/parametres", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  res.json(entry.engine.getSettings());
});

app.put("/api/:id/parametres", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  res.json(entry.engine.updateSettings(req.body || {}));
});

// -- Numero de notification personnel (recoit un message WhatsApp quand un client demande a parler a un
// humain) : le super-administrateur peut le regler pour n'importe quel marchand, un marchand pour
// lui-meme uniquement (verifierPortee s'en charge via getMarchandAutorise). Permission employe requise :
// "parametres" (c'est un reglage, pas une tache operationnelle du quotidien). --

app.put("/api/:id/notification", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  const { phoneNotification } = req.body || {};
  const maj = await db.updateMerchantFields(req.params.id, { phoneNotification: phoneNotification || null });
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.phoneNotification = maj.phoneNotification;
  res.json({ id: req.params.id, phoneNotification: maj.phoneNotification });
});

// -- Mise en relation avec un humain : conversations actuellement en pause, et reponse manuelle du
// marchand (envoyee au client via le meme compte WhatsApp que le bot). Permission employe requise :
// "conversations". --

app.get("/api/:id/conversations", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "conversations"); if (!entry) return;
  res.json(entry.engine.getConversationsEnAttente());
});

app.post("/api/:id/conversations/:telephone/repondre", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "conversations"); if (!entry) return;
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ erreur: "message requis." });
  const ok = await entry.engine.repondreConversationHumain(req.params.telephone, String(message));
  if (!ok) return res.status(404).json({ erreur: "Conversation introuvable (peut-être déjà reprise par le bot après 10 minutes)." });
  res.json({ ok: true });
});

// -- Historique complet des conversations (TOUS les echanges, pas seulement les mises en pause) : une
// liste des clients ayant deja ecrit, puis le detail d'un client donne. Permission employe requise :
// "conversations". --

app.get("/api/:id/conversations/historique", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "conversations"); if (!entry) return;
  try {
    res.json(await db.getConversationSummaries(req.params.id));
  } catch (erreur) {
    console.error(`[${req.params.id}] Echec de lecture de l'historique des conversations :`, erreur);
    res.status(500).json({ erreur: "Impossible de charger l'historique des conversations." });
  }
});

app.get("/api/:id/conversations/historique/:telephone", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "conversations"); if (!entry) return;
  try {
    res.json(await db.getConversationHistory(req.params.id, req.params.telephone));
  } catch (erreur) {
    console.error(`[${req.params.id}] Echec de lecture de l'historique d'une conversation :`, erreur);
    res.status(500).json({ erreur: "Impossible de charger cette conversation." });
  }
});

// -- Tableau de bord : statistiques resumees (commun aux deux types). Permission employe requise :
// "parametres" (chiffres/CA — regroupe avec les reglages, voir ROLES_EMPLOYE_VALIDES). --

app.get("/api/:id/tableau-de-bord", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  res.json(entry.engine.getTableauDeBord());
});

// -- Simulateur WhatsApp : permet au marchand de tester le bot depuis l'interface admin,
// sans jamais toucher aux vraies conversations/commandes/rendez-vous des clients (voir
// PHONE_SIMULATEUR dans conversation.js / conversationService.js). Accessible a un employe ayant le role
// operationnel de ce type de marchand ("catalogue" ou "rendezvous") OU le role "conversations" (tester le
// parcours bot fait aussi partie du service client). --

app.post("/api/:id/simulateur/message", protegerAcces, (req, res) => {
  const merchantExistant = engines[req.params.id];
  const permissionOperationnelle = merchantExistant && merchantExistant.merchant.type === "service" ? "rendezvous" : "catalogue";
  const entry = getMarchandAutorise(req, res, [permissionOperationnelle, "conversations"]); if (!entry) return;
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ erreur: "message requis." });
  res.json(entry.engine.handleMessageSimulateur(String(message)));
});

app.post("/api/:id/simulateur/reset", protegerAcces, (req, res) => {
  const merchantExistant = engines[req.params.id];
  const permissionOperationnelle = merchantExistant && merchantExistant.merchant.type === "service" ? "rendezvous" : "catalogue";
  const entry = getMarchandAutorise(req, res, [permissionOperationnelle, "conversations"]); if (!entry) return;
  entry.engine.resetSimulateur();
  res.json({ ok: true });
});

// -- Rapports et inventaire : reserves aux marchands de type catalogue. Permission employe requise :
// "parametres" (chiffres/analyses — regroupe avec le tableau de bord). --

app.get("/api/:id/rapports/commandes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { periode, date, articleId } = req.query || {};
  const dateReference = date ? new Date(String(date)) : new Date();
  res.json(entry.engine.getRapportCommandes({
    periode: periode ? String(periode) : "jour",
    dateReference,
    articleId: articleId ? String(articleId) : null,
  }));
});

app.get("/api/:id/inventaire/actuel", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.getInventaireActuel());
});

app.get("/api/:id/inventaire/instantanes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.listerInstantanesInventaire());
});

app.post("/api/:id/inventaire/instantanes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { nom } = req.body || {};
  res.status(201).json(entry.engine.enregistrerInstantaneInventaire(nom && String(nom).trim() ? String(nom).trim() : "Instantané"));
});

app.delete("/api/:id/inventaire/instantanes/:snapshotId", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const ok = entry.engine.supprimerInstantaneInventaire(req.params.snapshotId);
  if (!ok) return res.status(404).json({ erreur: "Instantané introuvable." });
  res.json({ ok: true });
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

    // Marchand suspendu (ex: facture impayee — voir /api/:id/actif) : on n'entre dans AUCUN traitement
    // normal (ni pagination, ni moteur de conversation), on repond une seule fois poliment et on
    // journalise quand meme l'echange pour garder une trace dans /admin.
    if (marchand.merchant.actif === false) {
      const texteBrut = message.text?.body || "[message non-texte]";
      // Le moteur ne traite pas ce message (bot desactive), mais si le client avait deja choisi sa langue
      // avant la suspension, sa session existe encore en memoire - on la reutilise ici pour rester dans la
      // meme langue plutot que de retomber sur le francais par defaut.
      const etatPourLangue = typeof marchand.engine.getEtatSession === "function" ? marchand.engine.getEtatSession(from) : null;
      const messageSuspendu = tW(etatPourLangue, MESSAGE_SERVICE_SUSPENDU_FR, MESSAGE_SERVICE_SUSPENDU_EN);
      db.logConversationMessage(merchantId, from, "client", texteBrut).catch(() => {});
      db.logConversationMessage(merchantId, from, "bot", messageSuspendu).catch(() => {});
      console.log(`[${merchantId}] Marchand suspendu — reponse d'indisponibilite envoyee a ${from}.`);
      await envoyerMessageWhatsApp(from, messageSuspendu, phoneNumberId);
      return;
    }

    // Clic sur "Voir plus d'articles/services ▸" (pagination d'un catalogue/service trop fourni pour
    // tenir sur une seule liste WhatsApp - 10 lignes max au total) : pure navigation d'affichage, ne
    // correspond a AUCUN texte que le client aurait pu taper et ne doit donc jamais passer par
    // engine.handleMessage() (qui changerait l'etat de la conversation). On envoie juste la page suivante.
    const idInteractifClique = message.type === "interactive"
      ? (message.interactive?.list_reply?.id || message.interactive?.button_reply?.id || "")
      : "";
    if (idInteractifClique.indexOf(PREFIXE_VOIR_PLUS) === 0) {
      const offset = Number(idInteractifClique.slice(PREFIXE_VOIR_PLUS.length)) || 0;
      const estCatalogue = marchand.engine.type === "catalogue";
      const items = construireItemsListe(marchand);
      const etatPourLangue = typeof marchand.engine.getEtatSession === "function" ? marchand.engine.getEtatSession(from) : null;
      const rows = construireLignesListe(items, offset, etatPourLangue);
      const texteCorps = estCatalogue
        ? tW(etatPourLangue, "Voici la suite de nos articles :", "Here are more of our items:")
        : tW(etatPourLangue, "Voici la suite de nos services :", "Here are more of our services:");
      db.logConversationMessage(merchantId, from, "client", "Voir plus " + (estCatalogue ? "d'articles" : "de services")).catch(() => {});
      const envoye = await envoyerListeWhatsApp(
        from, phoneNumberId, texteCorps,
        estCatalogue ? tW(etatPourLangue, "Voir les articles", "See items") : tW(etatPourLangue, "Voir les services", "See services"),
        [{ title: estCatalogue ? tW(etatPourLangue, "Nos articles", "Our items") : tW(etatPourLangue, "Nos services", "Our services"), rows }]
      ).catch(() => false);
      if (envoye) db.logConversationMessage(merchantId, from, "bot", texteCorps).catch(() => {});
      else await envoyerMessageWhatsApp(from, texteCorps + "\n" + items.slice(offset).map((it) => "• " + it.nom).join("\n"), phoneNumberId);
      return;
    }

    // Un clic sur une liste/un bouton (voir essayerEnvoyerMenuInteractif plus bas) arrive comme
    // message.type === "interactive" plutot que du texte libre - on le traduit en texte equivalent AVANT
    // de l'envoyer au moteur de conversation, qui n'a besoin de rien savoir de plus (meme logique de
    // reconnaissance que si le client avait tape la reponse lui-meme).
    let texteRecu = message.text?.body || "";
    if (!texteRecu && message.type === "interactive") {
      texteRecu = resoudreTexteInteractif(marchand, message.interactive) || "";
    }

    if (!texteRecu) {
      console.log(`[${merchantId}] Message non-texte recu de ${from} (type: ${message.type}) — reponse d'orientation envoyee.`);
      const etatPourLangue = typeof marchand.engine.getEtatSession === "function" ? marchand.engine.getEtatSession(from) : null;
      await envoyerMessageWhatsApp(
        from,
        tW(etatPourLangue,
          "Je ne peux lire que du texte pour l'instant 🙏 Merci de m'écrire votre demande en quelques mots.",
          "I can only read text for now 🙏 Please write your request in a few words."
        ),
        phoneNumberId
      );
      return;
    }

    console.log(`[${merchantId}] Message recu de ${from} : "${texteRecu}"`);

    const reponse = marchand.engine.handleMessage(from, texteRecu);

    // Une reponse "vide" (null) signifie que la conversation est en pause pour un humain (voir shared.js)
    // - on reste volontairement silencieux, le marchand repondra depuis /admin.
    if (reponse) {
      let envoiInteractifReussi = false;
      try {
        envoiInteractifReussi = await essayerEnvoyerMenuInteractif(marchand, from, phoneNumberId, reponse);
      } catch (erreur) {
        // Ne doit JAMAIS empecher le client de recevoir une reponse : en cas de pepin ici, on se rabat
        // simplement sur le texte simple juste en dessous.
        console.error(`[${merchantId}] Erreur lors de la construction du menu interactif (repli en texte) :`, erreur);
      }
      if (!envoiInteractifReussi) await envoyerMessageWhatsApp(from, reponse, phoneNumberId);
    } else {
      console.log(`[${merchantId}] Conversation en pause pour un humain — aucune reponse automatique envoyee a ${from}.`);
    }
  } catch (erreur) {
    console.error("Erreur lors du traitement du webhook :", erreur);
  }
});

// --- Menus WhatsApp cliquables (listes/boutons) : entierement en plus du texte libre existant, jamais a
// sa place. Un client peut toujours ignorer le menu et taper sa reponse comme avant - rien dans
// conversation.js/conversationService.js n'a change pour ca (voir engine.getEtatSession). ---

const ID_HUMAIN = "IZY_HUMAIN";
const ID_OUI = "IZY_OUI";
const ID_NON = "IZY_NON";
const PREFIXE_CRENEAU = "IZY_SLOT_";
const PREFIXE_VOIR_PLUS = "IZY_PLUS_";
// Panier multi-articles (moteur catalogue uniquement) : voir conversation.js (sh.demandeVoirPanier, stage
// "viewing_cart") et essayerEnvoyerMenuInteractif plus bas.
const ID_PANIER = "IZY_PANIER";
const ID_AUTRE_ARTICLE = "IZY_AUTRE";
const ID_PANIER_CONTINUER = "IZY_PANIER_CONTINUER";
const ID_PANIER_TERMINER = "IZY_PANIER_TERMINER";
const ID_LANG_FR = "IZY_LANG_FR";
const ID_LANG_EN = "IZY_LANG_EN";
const PREFIXE_RETIRER_PANIER = "IZY_DELCART_";

function tronquerTexte(texte, max) {
  const t = String(texte == null ? "" : texte);
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + "…" : t;
}

// Construit la liste plate des articles (catalogue) ou services d'un marchand, sous une forme commune
// {id, nom, description} - utilisee a la fois pour l'envoi de la 1ere page (essayerEnvoyerMenuInteractif)
// et pour les pages suivantes ("Voir plus", voir le handler du webhook plus haut).
function construireItemsListe(marchand) {
  const estCatalogue = marchand.engine.type === "catalogue";
  return estCatalogue
    ? marchand.engine.getCatalog().map((p) => {
        const prixMin = (p.variantes || []).length ? Math.min(...p.variantes.map((v) => v.prix)) : null;
        return { id: p.id, nom: p.nom, description: prixMin != null ? "À partir de " + sh.formatFcfa(prixMin) : "" };
      })
    : marchand.engine.getServices().map((s) => ({ id: s.id, nom: s.nom, description: s.dureeMinutes + " min — " + sh.formatFcfa(s.prix) }));
}

// Construit les lignes d'UNE page de liste WhatsApp a partir de `offset` (index de depart dans `items`) -
// max 10 lignes au total. "Parler a un conseiller" figure sur CHAQUE page (choix explicite du marchand),
// ce qui laisse 9 places pour les articles/services ; si plus de 9 restent apres cette page, la derniere
// place est prise par "Voir plus ▸" a la place d'un 9eme article, pour ne jamais depasser la limite tout
// en gardant tout le catalogue/service atteignable par clics (pas seulement les 9 premiers).
// `lignesSupplementaires` (optionnel) : lignes de navigation ajoutees avant "Parler à un conseiller" - ex.
// "◀ Autres articles" sur les listes de couleur/taille/variante (voir essayerEnvoyerMenuInteractif), pour
// permettre au client d'explorer le catalogue avant de se decider sans jamais y etre oblige.
function construireLignesListe(items, offset, etat, lignesSupplementaires) {
  const restant = items.length - offset;
  const inclureVoirPlus = restant > 9;
  const nbAffiches = inclureVoirPlus ? 8 : Math.max(0, Math.min(restant, 9));
  const page = items.slice(offset, offset + nbAffiches);
  const rows = page.map((it) => ({
    id: it.id,
    title: tronquerTexte(it.nom, 24),
    description: tronquerTexte(it.description, 72)
  }));
  if (inclureVoirPlus) {
    rows.push({ id: PREFIXE_VOIR_PLUS + (offset + nbAffiches), title: tW(etat, "Voir plus ▸", "See more ▸") });
  }
  (lignesSupplementaires || []).forEach((ligne) => rows.push(ligne));
  rows.push({ id: ID_HUMAIN, title: tW(etat, "Parler à un conseiller", "Talk to an advisor"), description: tW(etat, "Être mis en relation avec l'équipe", "Get connected with our team") });
  return rows;
}

// Traduit l'id d'une ligne de liste ou d'un bouton cliques par le client en texte equivalent - le moteur
// de conversation n'en sait rien, il recoit exactement ce qu'il recevrait si le client avait tape ce
// texte lui-meme (voir matchProduct/matchService/matchCouleur/matchTaille/demandeUnHumain/
// parseAffirmative/parseNegative). Les lignes de couleur/taille/variante (voir plus bas) utilisent
// directement le libelle affiche comme id : matchCouleur()/matchTaille() le reconnaissent nativement,
// donc aucune correspondance dediee n'est necessaire pour elles ici.
function resoudreTexteInteractif(marchand, interactive) {
  if (!interactive) return null;
  let id = null;
  if (interactive.type === "list_reply") id = interactive.list_reply?.id;
  else if (interactive.type === "button_reply") id = interactive.button_reply?.id;
  if (!id) return null;

  if (id === ID_LANG_FR) return "fr"; // reponse a la porte bilingue (voir sh.detecterChoixLangueInitial)
  if (id === ID_LANG_EN) return "en";
  if (id === ID_HUMAIN) return "un conseiller";
  if (id === ID_OUI) return "oui";
  if (id === ID_NON) return "non";
  if (id === ID_PANIER) return "voir mon panier";
  if (id === ID_AUTRE_ARTICLE) return "autre chose";
  if (id === ID_PANIER_CONTINUER) return "continuer mes achats";
  if (id === ID_PANIER_TERMINER) return "terminé";
  if (id.indexOf(PREFIXE_RETIRER_PANIER) === 0) return String(Number(id.slice(PREFIXE_RETIRER_PANIER.length)) + 1); // position 1-based dans le panier
  if (id.indexOf(PREFIXE_CRENEAU) === 0) return String(Number(id.slice(PREFIXE_CRENEAU.length)) + 1); // "1"/"2"/"3"

  // Id d'un article ou d'un service connu : on renvoie son nom exact, que matchProduct()/matchService()
  // reconnaissent deja nativement (il figure toujours dans leurs mots-cles). Sinon (couleur/taille/
  // variante, ou tres rare course : l'article a ete retire du catalogue entre l'envoi de la liste et le
  // clic du client) on renvoie l'id tel quel - il EST deja le texte a interpreter dans tous les autres cas.
  if (marchand.engine.type === "catalogue") {
    const p = marchand.engine.getCatalog().filter((x) => x.id === id)[0];
    return p ? p.nom : id;
  }
  const s = marchand.engine.getServices().filter((x) => x.id === id)[0];
  return s ? s.nom : id;
}

// Choisit FR ou EN pour le CHROME des menus WhatsApp cliquables (titres de boutons/listes, "Parler a un
// conseiller"...) selon la langue de la session cliente (voir getEtatSession, conversation.js) - "fr" par
// defaut si `etat` est absent/inconnu (avant tout choix de langue, ou moteur service pas encore bilingue).
function tW(etat, texteFr, texteEn) {
  return etat && etat.langue === "en" ? texteEn : texteFr;
}

// Tente d'accompagner `texte` (la reponse deja calculee par le moteur) d'un menu cliquable adapte a l'etat
// de la conversation. Renvoie true si un message interactif a bien ete envoye (rien d'autre a faire),
// false s'il n'y a pas de menu pertinent ICI ou si l'envoi a echoue (l'appelant se rabat alors sur
// envoyerMessageWhatsApp comme avant).
async function essayerEnvoyerMenuInteractif(marchand, destinataire, phoneNumberId, texte) {
  if (sh.estMessageMiseEnRelation(texte)) return false; // jamais de menu juste apres une mise en relation (FR ou EN)

  // Porte bilingue (tout premier message, voir sh.messageChoixLangue) : menu deroulant Français/English
  // plutot que de demander au client de taper "FR"/"EN" au clavier - meme logique "moins d'ecrit possible
  // pour le client" que le reste des menus tactiles ci-dessous. Fonctionne avant meme d'avoir une session
  // exploitable (etat de session pas encore pertinent a ce stade), d'ou le retour immediat ici.
  if (sh.estMessageChoixLangue(texte)) {
    return envoyerListeWhatsApp(destinataire, phoneNumberId, texte, "Choisir / Choose", [
      { title: "Langue / Language", rows: [
        { id: ID_LANG_FR, title: "Français", description: "Continuer en français" },
        { id: ID_LANG_EN, title: "English", description: "Continue in English" }
      ] }
    ]);
  }

  if (typeof marchand.engine.getEtatSession !== "function") return false;
  const etat = marchand.engine.getEtatSession(destinataire);
  if (!etat) return false;

  if (etat.stage === "idle" && etat.pretPourChoix) {
    const estCatalogue = marchand.engine.type === "catalogue";
    const items = construireItemsListe(marchand);
    if (!items.length) return false;
    const rows = construireLignesListe(items, 0, etat);

    return envoyerListeWhatsApp(
      destinataire,
      phoneNumberId,
      texte,
      estCatalogue ? tW(etat, "Voir les articles", "See items") : tW(etat, "Voir les services", "See services"),
      [{ title: estCatalogue ? tW(etat, "Nos articles", "Our items") : tW(etat, "Nos services", "Our services"), rows }]
    );
  }

  // Choix livraison vs retrait en boutique (voir conversation.js / retraitConfigure()) : seulement 2
  // options possibles -> boutons (avec le conseiller, ça tient exactement dans la limite de 3). Etape
  // dediee "awaiting_mode_livraison" (PAS "idle", contrairement a couleur/taille/variante ci-dessous).
  if (etat.stage === "awaiting_mode_livraison" && etat.pendingChoice && etat.pendingChoice.type === "mode_livraison") {
    const boutons = etat.pendingChoice.options.slice(0, 2).map((opt) => ({ id: String(opt), title: tronquerTexte(String(opt), 20) }));
    boutons.push({ id: ID_HUMAIN, title: tW(etat, "Parler à un conseiller", "Talk to an advisor") });
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, boutons);
  }

  // Choix d'une couleur, d'une taille, ou d'une variante de remplacement (rupture de stock) : memes
  // regles de liste que ci-dessus (9 options + "Parler a un conseiller"), voir conversation.js /
  // session.pendingChoice. N'existe que pour le moteur catalogue (le moteur service n'a pas de variantes).
  if (etat.stage === "idle" && etat.pendingChoice && etat.pendingChoice.options && etat.pendingChoice.options.length) {
    const pc = etat.pendingChoice;
    const labels = {
      couleur: { bouton: tW(etat, "Voir les couleurs", "See colors"), section: tW(etat, "Couleurs disponibles", "Available colors") },
      taille: { bouton: tW(etat, "Voir les tailles", "See sizes"), section: tW(etat, "Tailles disponibles", "Available sizes") },
      variante: { bouton: tW(etat, "Voir les options", "See options"), section: tW(etat, "Options disponibles", "Available options") }
    }[pc.type];
    if (!labels) return false;

    const items = pc.options.slice(0, 8).map((opt) => {
      const libelle = pc.type === "variante" ? opt.couleur + " " + opt.taille : String(opt);
      return { id: libelle, nom: libelle, description: "" };
    });
    // Le client peut regarder cette liste sans s'y engager : une ligne le ramène directement au catalogue
    // complet (voir conversation.js — abandon de la sélection en cours si le panier n'est pas vide, elle
    // reste intacte).
    const rows = construireLignesListe(items, 0, etat, [
      { id: ID_AUTRE_ARTICLE, title: tW(etat, "◀ Autres articles", "◀ Other items"), description: tW(etat, "Revenir au catalogue complet", "Back to the full catalog") }
    ]);

    return envoyerListeWhatsApp(destinataire, phoneNumberId, texte, labels.bouton, [{ title: labels.section, rows }]);
  }

  // Panier multi-articles (moteur catalogue uniquement) : 3 options tactiles au lieu du simple Oui/Non,
  // pour reprendre les achats, consulter/modifier le panier, ou valider - voir conversation.js
  // (session.stage "awaiting_more_items"/"viewing_cart") et sh.demandeVoirPanier().
  if (etat.stage === "awaiting_more_items") {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: ID_OUI, title: tW(etat, "Voir le catalogue", "Browse catalog") },
      { id: ID_PANIER, title: tW(etat, "Mon panier", "My cart") },
      { id: ID_NON, title: tW(etat, "Terminer", "Done") }
    ]);
  }

  // Vue panier : une ligne "retirer" par article (voir etat.cart, fourni par conversation.js), plus la
  // reprise des achats ou la validation de la commande.
  if (etat.stage === "viewing_cart" && etat.cart && etat.cart.length) {
    const rows = etat.cart.slice(0, 6).map((it, i) => ({
      id: PREFIXE_RETIRER_PANIER + i,
      title: tronquerTexte(it.produit, 24),
      description: tronquerTexte(tW(etat, "🗑️ Retirer — ", "🗑️ Remove — ") + it.couleur + " " + it.taille + " × " + it.quantite + " — " + sh.formatFcfa(it.prixUnitaire * it.quantite), 72)
    }));
    rows.push({ id: ID_PANIER_CONTINUER, title: tronquerTexte(tW(etat, "🛍️ Continuer mes achats", "🛍️ Keep shopping"), 24) });
    rows.push({ id: ID_PANIER_TERMINER, title: tronquerTexte(tW(etat, "✅ Terminer ma commande", "✅ Complete my order"), 24) });
    rows.push({ id: ID_HUMAIN, title: tW(etat, "Parler à un conseiller", "Talk to an advisor"), description: tW(etat, "Être mis en relation avec l'équipe", "Get connected with our team") });
    return envoyerListeWhatsApp(destinataire, phoneNumberId, texte, tW(etat, "Gérer mon panier", "Manage my cart"), [{ title: tW(etat, "Votre panier", "Your cart"), rows }]);
  }

  // Choix rapide de quantité (moteur catalogue) : 1, 2, ou retour au catalogue - le client garde aussi la
  // possibilité de taper n'importe quel autre nombre en texte libre comme avant (voir parseQuantity).
  if (etat.stage === "awaiting_quantity") {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: "1", title: "1" },
      { id: "2", title: "2" },
      { id: ID_AUTRE_ARTICLE, title: tW(etat, "◀ Autres articles", "◀ Other items") }
    ]);
  }

  if (etat.stage === "awaiting_order_confirmation" || etat.stage === "awaiting_confirmation") {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: ID_OUI, title: tW(etat, "Oui", "Yes") },
      { id: ID_NON, title: tW(etat, "Non", "No") }
    ]);
  }

  if (etat.stage === "awaiting_slot_choice" && etat.proposedSlots && etat.proposedSlots.length) {
    const boutons = etat.proposedSlots.slice(0, 3).map((slot, i) => ({
      id: PREFIXE_CRENEAU + i,
      title: tronquerTexte(
        new Date(slot).toLocaleString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
        20
      )
    }));
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, boutons);
  }

  return false;
}

// --- Fonction utilitaire : envoyer une liste WhatsApp cliquable (jusqu'a 10 lignes au total) ---
async function envoyerListeWhatsApp(destinataire, phoneNumberId, texteCorps, boutonListe, sections) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    console.error("WHATSAPP_TOKEN ou phone_number_id manquant — impossible d'envoyer la liste.");
    return false;
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  try {
    const reponse = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: destinataire,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: String(texteCorps).slice(0, 1020) },
          action: { button: boutonListe, sections },
        },
      }),
    });
    if (!reponse.ok) {
      const detail = await reponse.text();
      console.error(`Echec de l'envoi de la liste WhatsApp (${reponse.status}) :`, detail);
      return false;
    }
    return true;
  } catch (erreur) {
    console.error("Erreur reseau lors de l'envoi de la liste WhatsApp :", erreur);
    return false;
  }
}

// --- Fonction utilitaire : envoyer des boutons de reponse rapide WhatsApp (max 3) ---
async function envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texteCorps, boutons) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    console.error("WHATSAPP_TOKEN ou phone_number_id manquant — impossible d'envoyer les boutons.");
    return false;
  }
  if (!boutons || !boutons.length) return false;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  try {
    const reponse = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: destinataire,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: String(texteCorps).slice(0, 1020) },
          action: { buttons: boutons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: tronquerTexte(b.title, 20) } })) },
        },
      }),
    });
    if (!reponse.ok) {
      const detail = await reponse.text();
      console.error(`Echec de l'envoi des boutons WhatsApp (${reponse.status}) :`, detail);
      return false;
    }
    return true;
  } catch (erreur) {
    console.error("Erreur reseau lors de l'envoi des boutons WhatsApp :", erreur);
    return false;
  }
}

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

// --- Fonction utilitaire : envoyer une image via l'API WhatsApp Cloud, par lien (URL publique) ---
// Contrairement a l'API Media de Meta (upload prealable, media_id qui expire au bout de 30 jours), on
// passe ici directement un lien "link" : WhatsApp va chercher l'image a cette URL au moment de l'envoi,
// donc aucune notion d'expiration pour NOS photos d'articles (deja hebergees durablement sur R2, voir
// storage.js) - contrairement aux photos qu'un CLIENT enverrait, elles, au bot (fonctionnalite differente,
// non couverte ici).
async function envoyerImageWhatsApp(destinataire, urlImage, legende, phoneNumberId) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    console.error("WHATSAPP_TOKEN ou phone_number_id manquant — impossible d'envoyer la photo.");
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
      type: "image",
      image: { link: urlImage, caption: legende || undefined },
    }),
  });

  if (!reponse.ok) {
    const detail = await reponse.text();
    console.error(`Echec de l'envoi de la photo WhatsApp (${reponse.status}) :`, detail);
  } else {
    console.log("Photo envoyee avec succes.");
  }
}

// --- Fonction utilitaire : envoyer un template WhatsApp approuve via l'API Cloud ---
// Retourne true si l'envoi a reussi, false sinon (permet a l'appelant de basculer sur un repli). Ne
// leve jamais d'exception : toute erreur (reseau, template inexistant/non approuve, etc.) est capturee,
// journalisee, et traduite en simple `false`.
async function envoyerTemplateWhatsApp(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    console.error("WHATSAPP_TOKEN ou phone_number_id manquant — impossible d'envoyer le template.");
    return false;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const reponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: destinataire,
        type: "template",
        template: {
          name: nomTemplate,
          language: { code: langue },
          components: [
            {
              type: "body",
              parameters: parametresTexte.map((texte) => ({ type: "text", text: texte })),
            },
          ],
        },
      }),
    });

    if (!reponse.ok) {
      const detail = await reponse.text();
      console.error(`Echec de l'envoi du template WhatsApp "${nomTemplate}" (${reponse.status}) :`, detail);
      return false;
    }
    console.log(`Template WhatsApp "${nomTemplate}" envoye avec succes.`);
    return true;
  } catch (erreur) {
    console.error(`Erreur reseau lors de l'envoi du template WhatsApp "${nomTemplate}" :`, erreur);
    return false;
  }
}

const PORT = process.env.PORT || 3000;

// ---------------- Rappel automatique la veille des rendez-vous (volet service) ----------------
// Toutes les 30 minutes (fenetre de declenchement de 4h cote conversationService.js - voir
// RAPPEL_DELAI_MIN_MS/MAX_MS - donc largement assez frequent pour ne rater aucun rendez-vous), on demande
// a chaque moteur "service" actif d'envoyer les rappels dus. Best-effort et independant par marchand :
// l'echec d'un marchand (ex: token WhatsApp expire) n'empeche jamais les autres d'etre traites.
const INTERVALLE_RAPPELS_MS = 30 * 60 * 1000;

async function envoyerRappelsPourTousLesMarchands() {
  for (const merchantId of Object.keys(engines)) {
    const entry = engines[merchantId];
    if (!entry || entry.engine.type !== "service") continue;
    if (entry.merchant.actif === false) continue; // marchand suspendu : pas de rappel envoye
    try {
      await entry.engine.envoyerRappelsDuJour();
    } catch (erreur) {
      console.error(`[${merchantId}] Echec de l'envoi des rappels de rendez-vous :`, erreur);
    }
  }
}

// On attend que le registre des marchands + l'etat de chacun soient charges avant d'accepter la moindre
// requete. Voir chargerMarchands() / db.js.
async function demarrer() {
  await chargerMarchands();
  app.listen(PORT, () => {
    console.log(`Serveur IzyVendeur demarre sur le port ${PORT} (${Object.keys(engines).length} marchand(s) charge(s))`);
  });
  // Premier passage juste apres le chargement (ne bloque pas le demarrage du serveur), puis toutes les
  // INTERVALLE_RAPPELS_MS en continu.
  envoyerRappelsPourTousLesMarchands().catch((erreur) =>
    console.error("Echec du premier passage des rappels de rendez-vous :", erreur)
  );
  setInterval(() => {
    envoyerRappelsPourTousLesMarchands().catch((erreur) =>
      console.error("Echec du passage periodique des rappels de rendez-vous :", erreur)
    );
  }, INTERVALLE_RAPPELS_MS);
}

demarrer().catch((erreur) => {
  console.error("Echec du demarrage du serveur :", erreur);
  process.exit(1);
});
