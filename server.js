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
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const db = require("./db");
const storage = require("./storage");
const sh = require("./shared");
const createCatalogEngine = require("./conversation");
const createServiceEngine = require("./conversationService");
const createHebergementEngine = require("./conversationHebergement");
const createTransportEngine = require("./conversationTransport");
const importTransport = require("./importTransport");
const photosElements = require("./photosElements"); // Etape 77 : photos des services et des chambres (3 max)
const izyfacture = require("./izyfacture");
const rapportCaisse = require("./rapportCaisse");
const remisesLib = require("./remises");
const { creerMoteurFacturation, METHODES: METHODES_PAIEMENT, CATEGORIES_DEPENSE } = require("./facturation");
const cryptoUtil = require("./crypto-util");
const { clientIp } = require("./clientip");
const { creerRouteur, JETON_VOLET_CATALOGUE, JETON_VOLET_SERVICE, JETON_VOLET_HEBERGEMENT, JETON_VOLET_TRANSPORT } = require("./hybride");

const app = express();

// ---------------- Derriere Cloudflare (2 octobre 2026) ----------------
// IzyVendeur (et IzyFacture) sont desormais accedes via un domaine propre (izyvendeur.ccbconsulting.org)
// proxifie par Cloudflare, lui-meme devant Render - necessaire car l'operateur Orange Cameroun bloque les
// adresses *.onrender.com directement. Deux consequences cote serveur :
//   1) Sans ceci, TOUTE adresse IP vue par l'application serait celle de Cloudflare (quelques adresses
//      partagees par des millions de visiteurs), jamais celle du vrai client - `trust proxy` (un seul saut :
//      le propre proxy de Render, qui ajoute SON PROPRE en-tete X-Forwarded-For) + clientIp (ci-dessous,
//      voir clientip.js) restaurent l'adresse reelle via l'en-tete CF-Connecting-IP, mais UNIQUEMENT quand
//      la requete provient reellement d'une adresse Cloudflare connue - sinon n'importe qui pourrait
//      pretendre etre n'importe quelle adresse en appelant directement l'URL .onrender.com avec cet en-tete
//      invente. Rien n'utilise encore req.ip aujourd'hui (pas de limiteur de requetes), mais c'est desormais
//      fiable pour tout ce qui en aura besoin plus tard (journalisation, anti-abus).
//   2) Les pages ouvertes par un navigateur (jamais le webhook ni l'API - voir plus bas) redirigent
//      automatiquement une visite directe sur l'ancienne adresse .onrender.com vers le nouveau domaine, pour
//      que personne ne reste coince sur une adresse qui ne fonctionne plus depuis le reseau Orange.
app.set("trust proxy", 1);
app.use(clientIp);

const DOMAINE_PUBLIC = process.env.DOMAINE_PUBLIC || null; // ex: "izyvendeur.ccbconsulting.org" (optionnelle)
app.use((req, res, next) => {
  if (
    DOMAINE_PUBLIC &&
    req.method === "GET" &&
    /\.onrender\.com$/i.test(req.hostname || "") &&
    req.path !== "/webhook" &&
    !req.path.startsWith("/api/")
  ) {
    return res.redirect(301, "https://" + DOMAINE_PUBLIC + req.originalUrl);
  }
  next();
});

// `verify` : conserve le corps BRUT (avant parsing JSON) dans req.rawBody - necessaire pour recalculer la
// signature HMAC X-Hub-Signature-256 de Meta (voir verifierSignatureWebhook plus bas), qui porte sur les
// octets exacts envoyes, pas sur une version re-serialisee de req.body (qui pourrait legerement differer :
// ordre des cles, espacement...). N'affecte aucune route existante - simple capture en plus du parsing JSON
// habituel, qui continue de fonctionner exactement comme avant pour tout le reste (y compris /api/...).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Upload de photos d'articles : conserve le fichier en memoire (jamais sur disque, Render l'efface de
// toute facon a chaque redemarrage) le temps de le transferer vers R2 - voir storage.js. Une seule photo
// a la fois par requete, plafonnee a 5 Mo (alignee sur la limite WhatsApp), le reste de la validation
// (format d'image) se fait dans storage.js.
const uploadPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Import en masse du catalogue (Etape 23, 27 sept 2026) : conserve le fichier CSV en memoire le temps de
// le lire (jamais ecrit sur disque), plafonne a 2 Mo - largement suffisant pour un catalogue meme de
// plusieurs centaines d'articles (voir POST /api/:id/catalogue/importer plus bas).
const uploadFichierCatalogue = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_API_VERSION = "v21.0";

// ---------------- Signature du webhook WhatsApp (2 octobre 2026) ----------------
// VERIFY_TOKEN (ci-dessus) ne protege qu'UNE SEULE requete : la verification GET faite une fois par Meta au
// moment de l'abonnement du webhook. Il ne protege PAS les requetes POST envoyees ensuite a chaque message -
// n'importe qui connaissant l'URL du webhook (publique par nature) pouvait jusqu'ici poster un faux message
// WhatsApp qui aurait ete traite comme authentique. Meta signe en realite CHAQUE requete POST avec un HMAC-
// SHA256 du corps exact (en-tete X-Hub-Signature-256), calcule avec le "App Secret" de l'app Meta (Settings
// > Basic du portefeuille, PAS le jeton WHATSAPP_TOKEN ni VERIFY_TOKEN) - jusqu'ici jamais verifie. Repli
// DELIBERE (meme principe que ENCRYPTION_KEY/SESSION_SECRET dans crypto-util.js) si WHATSAPP_APP_SECRET
// n'est pas definie : on accepte quand meme les requetes (comportement inchange par rapport a avant), mais
// avec un avertissement explicite au demarrage, pour qu'une absence en production ne passe jamais inapercue.
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || null;
if (!WHATSAPP_APP_SECRET) {
  console.warn(
    "[securite webhook] WHATSAPP_APP_SECRET non definie : les requetes POST /webhook sont acceptees SANS " +
    "verifier leur signature Meta (X-Hub-Signature-256). Definissez WHATSAPP_APP_SECRET sur Render (App " +
    "Secret de l'app Meta, Settings > Basic) pour activer cette protection."
  );
}

// Verifie la signature HMAC-SHA256 d'une requete POST /webhook contre WHATSAPP_APP_SECRET. Retourne true si
// la signature est valide OU si WHATSAPP_APP_SECRET n'est pas configuree (voir avertissement ci-dessus) -
// false uniquement quand une cle EST configuree et que la signature presentee ne correspond pas (requete
// forgee, ou corps altere en route). Comparaison a temps constant (timingSafeEqual), comme pour les jetons
// de session (voir crypto-util.js) - evite qu'une difference de temps de reponse ne permette de deviner la
// signature attendue octet par octet.
function verifierSignatureWebhook(req) {
  if (!WHATSAPP_APP_SECRET) return true;
  const entete = String(req.get("x-hub-signature-256") || "");
  if (!entete.startsWith("sha256=")) return false;
  const attendue =
    "sha256=" + crypto.createHmac("sha256", WHATSAPP_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest("hex");
  const bufRecu = Buffer.from(entete);
  const bufAttendu = Buffer.from(attendue);
  if (bufRecu.length !== bufAttendu.length) return false;
  return crypto.timingSafeEqual(bufRecu, bufAttendu);
}

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
// `parametresNoms` (ajoute le 27 septembre 2026) : Meta a change son formulaire de creation de template
// dans WhatsApp Manager pour n'accepter QUE des variables nommees ({{nom_variable}}, lettres
// minuscules/underscores/chiffres) au lieu des anciennes variables numerotees ({{1}}, {{2}}...) - un
// template cree APRES ce changement exige que l'appel a l'API envoie aussi `parameter_name` pour chaque
// valeur (sinon Meta refuse l'envoi, meme template par ailleurs approuve). Les templates plus anciens
// (crees avant ce changement, avec {{1}}/{{2}}) continuent eux de fonctionner SANS `parameter_name`. Comme
// il n'y a aucun moyen de savoir a l'avance, pour un marchand donne, sous quelle forme SON template a ete
// approuve, `envoyerTemplateWhatsApp` (voir plus bas) essaie d'abord SANS `parameter_name` (ancien format)
// puis, seulement si ce premier essai echoue, ressaie UNE fois AVEC (nouveau format) - voir les tests
// HTTP dedies a ce comportement. `parametresNoms` fournit les noms a utiliser pour ce 2e essai, dans le
// meme ordre que les valeurs ci-dessous ; ordre et noms doivent correspondre EXACTEMENT a ce qui a ete
// declare dans le modele cote Meta.
const TEMPLATES_ALERTE_MARCHAND = {
  humain: {
    nom: "izyvendeur_alerte_humain",
    langue: "fr",
    // params: [telephoneClient, messageClient]
    parametresNoms: ["telephone_client", "message_client"],
    texteLibreRepli: (params) =>
      "Un client (" + params[0] + ") souhaite parler à quelqu'un :\n« " + params[1] + " »\n\n" +
      "Répondez-lui depuis /admin, onglet Conversations."
  },
  commande_confirmee: {
    nom: "izyvendeur_alerte_commande",
    langue: "fr",
    // params: [reference, resumeArticles, total, telephoneClient, adresse]
    parametresNoms: ["reference", "articles", "total", "telephone_client", "adresse"],
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
    parametresNoms: ["reference", "service", "creneau", "prix", "client_nom", "telephone_client"],
    texteLibreRepli: (params) =>
      "Nouveau rendez-vous confirmé " + params[0] + " :\n" + params[1] + "\nCréneau : " + params[2] +
      "\nPrix : " + params[3] + "\nClient : " + params[4] + "\nTéléphone : " + params[5] +
      "\n\nConsultez /admin, onglet Rendez-vous, pour le suivre."
  },
  // Etape 61 : alerte quand une CLIENTE annule ou deplace son rendez-vous (WhatsApp). Un seul modele Meta pour les
  // deux cas, nomme EXACTEMENT "izyvendeur_alerte_rdv_change" (langue fr), 7 variables dans cet ordre.
  rdv_modifie: {
    nom: "izyvendeur_alerte_rdv_change",
    langue: "fr",
    // params: [reference, serviceEtPraticien, action ("annulé par la cliente"/"déplacé par la cliente"), ancienCreneau, nouveauCreneau, clientNom, telephoneClient]
    parametresNoms: ["reference", "service", "action", "ancien_creneau", "nouveau_creneau", "client_nom", "telephone_client"],
    texteLibreRepli: (params) =>
      "Rendez-vous " + params[0] + " (" + params[1] + ") " + params[2] + ".\nAncien créneau : " + params[3] +
      "\nNouveau créneau : " + params[4] + "\nClient : " + params[5] + ", téléphone " + params[6] +
      "\n\nConsultez /admin, onglet Rendez-vous."
  }
};

// Template WhatsApp envoye AU CLIENT (et non au marchand) : le rappel de rendez-vous (Etape 44). Un rappel
// part la veille, bien apres la derniere reponse du client : WhatsApp refuse alors le texte libre (fenetre de
// 24 h depassee, erreur 131047) et seul un template approuve passe. Marche a suivre cote Meta (WhatsApp
// Manager > Modeles de messages, categorie "Utilitaire") : creer le modele nomme EXACTEMENT
// "izyvendeur_rappel_rdv", en francais (code "fr") ET en anglais (code "en") sous ce MEME nom, avec 4
// variables nommees dans cet ordre : {{client_nom}}, {{service}}, {{creneau}}, {{entreprise}}. Texte
// suggere (fr) : "Bonjour {{client_nom}}, petit rappel de votre rendez-vous {{service}} le {{creneau}} chez
// {{entreprise}}. Pour reporter ou annuler, repondez-nous ici." ; (en) : "Hello {{client_nom}}, a friendly
// reminder of your {{service}} appointment on {{creneau}} at {{entreprise}}. To reschedule or cancel, just
// reply here." Tant qu'il n'est pas approuve, le rappel part en texte libre quand c'est possible (client qui
// a ecrit dans les 24 h) et l'echec est signale dans /admin > Rendez-vous sinon.
const TEMPLATES_CLIENT = {
  rappel_rdv: {
    nom: "izyvendeur_rappel_rdv",
    langueFr: "fr",
    langueEn: "en",
    // params: [client, service(+praticien), creneau, entreprise]
    parametresNoms: ["client_nom", "service", "creneau", "entreprise"]
  }
};

// ---------------- Registre des marchands + moteurs de conversation ----------------
// engines[merchantId] = { merchant, engine }  -- engine expose toujours handleMessage(fromPhone, texte),
// quel que soit son type (catalogue ou service), ce qui garde le webhook simple.
const engines = {};
const phoneNumberIndex = {}; // phone_number_id WhatsApp -> merchantId

// ---------------- Marchand HYBRIDE (Etape 47) : un numero, deux volets ----------------
// Un marchand a toujours un volet PRINCIPAL (`type`, choisi a la creation) et peut avoir un SECOND volet
// (`moduleSecondaire`, accorde par le super-administrateur seul). Chaque volet a son propre moteur ; le
// principal garde l'etat enregistre sous l'id du marchand (donc rien ne change pour les marchands
// existants), le second sous une cle d'etat distincte. engines[id] = { merchant, engine (= principal),
// moteurs: { catalogue?, service? }, routeur? (seulement si deux moteurs) }.
// Etape 66 : jusqu'a TROIS volets (catalogue, service, hebergement), Etape 74 : QUATRE avec le transport (jusqu'a TROIS volets secondaires).
// `moduleSecondaire` est une chaine « service » ou « service,hebergement » (voir db.normaliserModulesSecondaires).
const VOLETS_VALIDES = ["catalogue", "service", "hebergement", "transport"];
function listeSecondaires(brut, type) {
  const norm = db.normaliserModulesSecondaires(brut);
  return norm ? norm.split(",").filter((v) => v !== type) : [];
}
function modulesDuMarchand(m) {
  return [m.type].concat(listeSecondaires(m.moduleSecondaire, m.type));
}
function cleEtatSecondaire(m, module) { return m.id + "::" + module; }
// Demande brute (chaine, liste ou « aucun ») -> { liste } valide, ou { erreur }.
function lireDemandeSecondaires(brut, type) {
  if (brut === undefined || brut === null || brut === "" || brut === "aucun") return { liste: [] };
  const entree = Array.isArray(brut) ? brut : String(brut).split(",");
  const liste = [];
  for (const v of entree) {
    const t = String(v || "").trim();
    if (!t || t === "aucun") continue;
    if (VOLETS_VALIDES.indexOf(t) === -1) return { erreur: "moduleSecondaire doit être 'catalogue', 'service', 'hebergement' ou 'transport' (trois au plus), ou null." };
    if (t === type) return { erreur: "Le second volet doit être différent du type principal (" + type + ")." };
    if (liste.indexOf(t) !== -1) return { erreur: "Un même volet ne peut pas être accordé deux fois." };
    liste.push(t);
  }
  if (liste.length > 3) return { erreur: "Quatre volets au maximum par marchand (le principal + trois autres)." };
  return { liste };
}

function fabriquerMoteur(type, merchantKey, optionsSupplementaires) {
  const options = Object.assign(creerOptionsEngine(merchantKey), optionsSupplementaires || {});
  if (type === "hebergement") return createHebergementEngine(merchantKey, options);
  if (type === "transport") return createTransportEngine(merchantKey, options);
  return type === "service" ? createServiceEngine(merchantKey, options) : createCatalogEngine(merchantKey, options);
}

// Construit (et initialise) tous les moteurs d'un marchand + son routeur s'il est hybride.
async function construireEntree(m) {
  const moteurs = {};
  moteurs[m.type] = fabriquerMoteur(m.type, m.id);
  await moteurs[m.type].init();
  const modules = modulesDuMarchand(m);
  for (const second of modules.slice(1)) {
    moteurs[second] = fabriquerMoteur(second, m.id, { cleEtat: cleEtatSecondaire(m, second), sansDonneesDemo: true });
    await moteurs[second].init();
  }
  const entree = { merchant: m, engine: moteurs[m.type], moteurs };
  // Etape 54 : moteur de facturation integree (etat range sous "<id>__facturation", voir facturation.js).
  // Toujours charge ; c'est la SOURCE choisie par le super-administrateur qui decide s'il sert ou non.
  entree.facturation = creerMoteurFacturation(m.id);
  await entree.facturation.init();
  if (modules.length > 1) { entree.routeur = creerRouteurPourMarchand(m, moteurs); await entree.routeur.chargerSessions(); }
  return entree;
}

function creerRouteurPourMarchand(m, moteurs) {
  return creerRouteur(moteurs, m.type, {
    cle: m.id + "::routeur", // Etape 72 : etat de routage sauvegarde (menu, volet courant, langue)
    // Le Simulateur de /admin ne laisse jamais de trace dans le vrai journal des conversations.
    journaliser: (tel, de, texte) => { if (tel !== "SIMULATEUR") db.logConversationMessage(m.id, tel, de, texte).catch(() => {}); }
  });
}

// Etape 48 : accorde (ou retire) le second volet d'un marchand DEJA charge, a chaud, sans redemarrage.
// L'objet `entry` est modifie EN PLACE (les routes et boucles qui le tiennent voient le changement).
// Retirer le second volet le MASQUE seulement : son etat reste enregistre sous sa cle (`<id>::<volet>`) et
// n'est jamais supprime ; l'accorder a nouveau le retrouve tel quel.
async function appliquerModuleSecondaire(entry, modules) {
  const m = entry.merchant;
  const demande = Array.isArray(modules) ? modules : (modules ? [modules] : []);
  const cibles = [];
  demande.forEach((v) => { if (VOLETS_VALIDES.indexOf(v) !== -1 && v !== m.type && cibles.indexOf(v) === -1) cibles.push(v); });
  cibles.splice(3);
  const actuels = modulesDuMarchand(m).slice(1);
  if (cibles.join(",") === actuels.join(",")) return;
  for (const v of actuels) {
    if (cibles.indexOf(v) === -1) delete entry.moteurs[v];
  }
  for (const v of cibles) {
    if (!entry.moteurs[v]) {
      const moteur = fabriquerMoteur(v, m.id, { cleEtat: cleEtatSecondaire(m, v), sansDonneesDemo: true });
      await moteur.init();
      entry.moteurs[v] = moteur;
    }
  }
  m.moduleSecondaire = cibles.join(",") || null;
  if (Object.keys(entry.moteurs).length > 1) { entry.routeur = creerRouteurPourMarchand(m, entry.moteurs); await entry.routeur.chargerSessions(); }
  else delete entry.routeur;
}

function estHybride(entry) { return !!(entry && entry.routeur); }

// Vue d'une entree pour UN volet : meme marchand, mais `engine` = le moteur de ce volet. Permet a tout le
// code existant (routes /admin, facturation IzyFacture, webhook...) qui lit `entry.engine` de fonctionner
// tel quel sur le bon volet d'un marchand hybride. Pour un marchand a un seul moteur, ou un volet qu'il
// n'a pas, renvoie l'entree elle-meme (le controle de type de chaque route repond alors 400 comme avant).
function vueEntree(entry, type) {
  if (!entry || !entry.moteurs || !entry.moteurs[type] || entry.engine.type === type) return entry;
  return { merchant: entry.merchant, engine: entry.moteurs[type], moteurs: entry.moteurs, routeur: entry.routeur, volet: type, facturation: entry.facturation };
}

// Pour les routes /admin : quelle(s) vue(s) d'un marchand hybride une permission implique-t-elle ?
// Les permissions propres a un volet (catalogue, commandes, caisse, inventaire, rapports -> catalogue ;
// rendezvous -> service) l'imposent ; les autres (parametres, tableau de bord, simulateur, conversations...)
// s'appliquent aux deux volets et utilisent `?volet=` (principal par defaut).
const VOLET_DE_PERMISSION = { catalogue: "catalogue", commandes: "catalogue", caisse: "catalogue", inventaire: "catalogue", rapports: "catalogue", rendezvous: "service" };
// Permission employe du role operationnel de chaque type de volet (l'hebergement partage « rendezvous » : reservations).
// ---- Etape 76 : numeros d'alerte supplementaires (option payante, quota fixe par le SEUL super-administrateur) ----
// Le numero historique (phoneNotification) reste a part ; les numeros supplementaires n'ont d'effet que dans la limite du quota :
// un quota ramene a 0 (ou reduit) coupe aussitot les envois vers les numeros en trop, sans rien effacer.
const PLAFOND_NUMEROS_NOTIFICATION_SUPP = Math.max(1, parseInt(process.env.MAX_NUMEROS_NOTIFICATION_SUPP, 10) || 50);
function chiffresTel(t) { return String(t == null ? "" : t).replace(/\D/g, ""); }
function quotaNumerosSupp(merchant) { const n = merchant && merchant.nbNumerosNotificationSupp; return Number.isInteger(n) && n > 0 ? Math.min(n, PLAFOND_NUMEROS_NOTIFICATION_SUPP) : 0; }
function numerosAlerteDe(merchant) {
  const liste = []; const vus = new Set();
  const ajouter = (n) => { const c = chiffresTel(n); if (!c || vus.has(c)) return; vus.add(c); liste.push(String(n).trim()); };
  ajouter(merchant && merchant.phoneNotification);
  ((merchant && Array.isArray(merchant.numerosNotificationSupp)) ? merchant.numerosNotificationSupp : []).slice(0, quotaNumerosSupp(merchant)).forEach(ajouter);
  return liste;
}

function permissionDuVolet(t) { return t === "service" || t === "hebergement" || t === "transport" ? "rendezvous" : "catalogue"; }
function vuePourRequete(req, entry, permission) {
  if (!entry || !entry.moteurs || Object.keys(entry.moteurs).length < 2) return entry;
  const perms = Array.isArray(permission) ? permission : (permission ? [permission] : []);
  const impliques = perms.map((p) => VOLET_DE_PERMISSION[p]);
  if (perms.length && impliques.every(Boolean) && new Set(impliques).size === 1) return vueEntree(entry, impliques[0]);
  const demande = req.query && req.query.volet ? String(req.query.volet) : null;
  if (demande && entry.moteurs[demande]) return vueEntree(entry, demande);
  return entry;
}

// Fournit a un moteur de conversation les fonctions dont il a besoin pour parler a WhatsApp lui-meme (au
// lieu de renvoyer simplement une reponse au webhook) : envoyer un message texte a N'IMPORTE QUEL numero
// (reponses manuelles du marchand a un client mis en pause), envoyer une photo d'article (voir
// storage.js), et notifier le numero de notification personnel du marchand (no-op si non configure).
// Toujours resolues au moment de l'appel via `engines[merchantKey]` pour rester a jour meme si le
// marchand change de numero/notification apres coup.
function creerOptionsEngine(merchantKey) {
  return {
    // Etape 60 : nom commercial du marchand pour l'accueil du moteur rendez-vous ("Bienvenue chez <nom>").
    nomMarchand: () => { const e = engines[merchantKey]; return (e && e.merchant && e.merchant.nom) || ""; },
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
    // Rappel de rendez-vous AU CLIENT (Etape 44) : texte libre d'abord (gratuit, passe si le client a ecrit
    // dans les 24 h), puis repli sur le template approuve TEMPLATES_CLIENT.rappel_rdv. Renvoie
    // { ok, canal, erreur } pour que le moteur sache s'il doit reessayer (voir envoyerRappelsDuJour).
    envoyerRappel: async (destinataire, texteLibre, info) => {
      const entry = engines[merchantKey];
      if (!entry) return { ok: false, erreur: "Marchand introuvable" };
      const phoneNumberId = entry.merchant.phoneNumberId;
      if (!phoneNumberId || !WHATSAPP_TOKEN) return { ok: false, erreur: "WhatsApp non configuré (token ou numéro manquant)" };
      try {
        if (await envoyerMessageWhatsApp(destinataire, texteLibre, phoneNumberId)) return { ok: true, canal: "texte" };
      } catch (erreur) {
        console.error(`[${merchantKey}] Erreur réseau lors du rappel en texte libre :`, erreur);
      }
      const config = TEMPLATES_CLIENT.rappel_rdv;
      const langue = info && info.langue === "en" ? config.langueEn : config.langueFr;
      const parametres = ((info && info.parametres) || []).concat([entry.merchant.nom || ""]).map(nettoyerPourTemplate);
      const envoiTemplateReussi = await envoyerTemplateWhatsApp(destinataire, phoneNumberId, config.nom, langue, parametres, config.parametresNoms);
      if (envoiTemplateReussi) return { ok: true, canal: "template" };
      return {
        ok: false,
        erreur: "Texte libre refusé par WhatsApp (probablement hors de la fenêtre de 24 h) et template \"" + config.nom + "\" (" + langue + ") non envoyé — créé et approuvé chez Meta ?"
      };
    },
    // `typeAlerte` choisit le template (voir TEMPLATES_ALERTE_MARCHAND ci-dessus) ; `params` est la liste
    // de valeurs BRUTES (pas encore mises en forme) a inserer dans ses variables, dans l'ordre. C'est ici,
    // et seulement ici, qu'on sait s'il faut passer par un template ou par du texte libre de secours.
    notifierMarchand: async (typeAlerte, params) => {
      const entry = engines[merchantKey];
      if (!entry) return;
      // Etape 76 : l'alerte part vers le numero historique ET vers les numeros supplementaires autorises par le quota
      // (meme alerte pour tous). L'echec d'un numero n'empeche jamais l'envoi aux autres.
      const destinataires = numerosAlerteDe(entry.merchant);
      if (!destinataires.length) return;
      const config = TEMPLATES_ALERTE_MARCHAND[typeAlerte];
      if (!config) {
        console.error(`[${merchantKey}] Type d'alerte marchand inconnu : "${typeAlerte}".`);
        return;
      }
      const phoneNumberId = entry.merchant.phoneNumberId;
      const parametresNettoyes = params.map(nettoyerPourTemplate);
      await Promise.all(destinataires.map(async (destinataire) => {
        try {
          const envoiTemplateReussi = await envoyerTemplateWhatsApp(
            destinataire,
            phoneNumberId,
            config.nom,
            config.langue,
            parametresNettoyes,
            config.parametresNoms
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
        } catch (erreur) {
          console.error(`[${merchantKey}] Echec de l'alerte vers un numero de notification :`, erreur);
        }
      }));
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
    engines[m.id] = await construireEntree(m);
    if (m.phoneNumberId) phoneNumberIndex[m.phoneNumberId] = m.id;
    const modules = modulesDuMarchand(m);
    console.log("Marchand charge : " + m.id + " (" + (modules.length > 1 ? "hybride : " + modules.join(" + ") : m.type) + ")" + (m.phoneNumberId ? " — numero " + m.phoneNumberId : " — AUCUN numero WhatsApp associe"));
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
// peut cumuler plusieurs de ces roles. "catalogue" et "commandes" n'ont de sens que pour un marchand de
// type catalogue, "rendezvous" que pour un marchand de type service ; "conversations" et "parametres"
// s'appliquent aux deux types. Le PROPRIETAIRE du marchand (role "marchand") et le super-administrateur
// ont eux toujours acces a tout ce qui concerne LEUR marchand, quels que soient ces roles - la restriction
// ne s'applique qu'aux employes.
// "commandes" (demande le 25 septembre 2026) est un role a part entiere, distinct de "conversations" :
// jusque-la, voir/traiter les commandes etait rattache au role "conversations" (voir commentaire retire
// plus bas, pres des routes /api/:id/commandes) - desormais un employe peut avoir l'un sans l'autre.
// "tableaudebord" (demande le 25 septembre 2026) est de meme desormais distinct de "parametres" : jusque-la
// le Tableau de bord (commun aux deux types), et pour un marchand catalogue les Rapports/l'Inventaire,
// etaient rattaches au role "parametres" (regroupement "chiffres/analyses" avec les reglages) - desormais
// "parametres" ne couvre plus que les vrais reglages (Paramètres + Mon compte), et "tableaudebord" couvre
// le Tableau de bord (commun aux deux types de marchand).
// "rapports" (demande le 25 septembre 2026, meme journee) detache a son tour Rapports et Inventaire de
// "tableaudebord" - ces deux volets etaient affiches ensemble dans un seul onglet "Rapports" de /admin
// (marchand catalogue uniquement).
// "inventaire" (demande juste apres, meme journee) separe a son tour Rapports et Inventaire ENTRE EUX :
// l'onglet unique "Rapports" est scinde en deux onglets distincts, "Rapports" (statistiques de commandes,
// route /api/:id/rapports/commandes) et "Inventaire" (instantanes de stock, routes /api/:id/inventaire/*),
// chacun avec son propre droit employe.
// Une migration au demarrage (voir db.js, initRegistry) ajoute automatiquement "commandes" a tout employe
// qui avait deja "conversations", "tableaudebord" a tout employe qui avait deja "parametres", "rapports" a
// tout employe qui avait deja "tableaudebord", et "inventaire" a tout employe qui avait deja "rapports" -
// que chaque etape soit de longue date ou tout juste migree a l'instant dans la meme passe - pour ne
// retirer d'acces a personne au fil de ces changements successifs.
// "caisse" (29 septembre 2026) : encaissement en boutique physique (onglet Caisse, voir POST
// /api/:id/pos/vente plus bas) - marchand catalogue uniquement, et l'onglet lui-meme reste invisible tant
// que le super-administrateur n'a pas debloque l'option payante "optionCaissePos" pour ce marchand (voir
// PUT /api/marchands/:id/options-payantes), meme si l'employe a deja ce role.
const ROLES_EMPLOYE_VALIDES = ["catalogue", "commandes", "rendezvous", "conversations", "parametres", "tableaudebord", "rapports", "inventaire", "caisse", "facturation", "comptable", "remises"];

// ---------------- Session de connexion /admin (29 septembre 2026) ----------------
// Remplace l'authentification HTTP Basic (popup native du navigateur - aucune notion de "session" ni de
// deconnexion fiable, voir l'ancienne version de protegerAcces ci-dessous dans l'historique) par un vrai
// ecran de connexion (POST /api/connexion) + un cookie contenant un jeton SIGNE (crypto-util.js). Aucune
// session n'est stockee cote serveur : protegerAcces revalide a CHAQUE requete contre les donnees EN DIRECT
// (engines), jamais contre le contenu du jeton seul - un marchand supprime/suspendu ou un employe dont le
// role a change perd donc l'acces immediatement, meme avec un jeton encore cryptographiquement valide.
const NOM_COOKIE_SESSION = "izy_session";
const DUREE_SESSION_MS = 24 * 60 * 60 * 1000; // 24h, glissante : reemise a chaque requete authentifiee reussie

function lireCookie(req, nom) {
  const enTete = req.headers.cookie || "";
  for (const morceau of enTete.split(";")) {
    const i = morceau.indexOf("=");
    if (i === -1) continue;
    if (morceau.slice(0, i).trim() === nom) {
      try { return decodeURIComponent(morceau.slice(i + 1).trim()); } catch (erreur) { return null; }
    }
  }
  return null;
}

function ecrireCookieSession(res, payload) {
  const jeton = cryptoUtil.genererJetonSession(payload, DUREE_SESSION_MS);
  const attributs = [
    NOM_COOKIE_SESSION + "=" + encodeURIComponent(jeton),
    "Path=/", "HttpOnly", "SameSite=Lax",
    "Max-Age=" + Math.floor(DUREE_SESSION_MS / 1000)
  ];
  if (process.env.NODE_ENV === "production") attributs.push("Secure");
  res.set("Set-Cookie", attributs.join("; "));
}

function effacerCookieSession(res) {
  const attributs = [NOM_COOKIE_SESSION + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (process.env.NODE_ENV === "production") attributs.push("Secure");
  res.set("Set-Cookie", attributs.join("; "));
}

// Verifie un identifiant/mot de passe fournis contre les 3 sources possibles (superadmin / marchand /
// employe), dans cet ordre - EXACTEMENT la meme logique que l'ancienne authentification Basic Auth,
// reutilisee ici par POST /api/connexion. Retourne l'objet req.auth correspondant, ou null si aucune
// correspondance (identifiant inconnu ou mot de passe errone).
function identifierCompte(utilisateur, motDePasse) {
  const superUtilisateur = process.env.ADMIN_USER || "admin";
  const superMotDePasse = process.env.ADMIN_PASSWORD;
  if (superMotDePasse && utilisateur === superUtilisateur && motDePasse === superMotDePasse) {
    return { role: "superadmin", merchantId: null, adminUser: utilisateur };
  }
  for (const id of Object.keys(engines)) {
    const m = engines[id].merchant;
    if (m.adminUser && utilisateur === m.adminUser && motDePasseCorrespond(motDePasse, m.adminPassword)) {
      return { role: "marchand", merchantId: id, adminUser: utilisateur };
    }
    for (const emp of (m.employes || [])) {
      if (emp.identifiant && utilisateur === emp.identifiant && motDePasseCorrespond(motDePasse, emp.motDePasseHash)) {
        return { role: "employe", merchantId: id, adminUser: utilisateur, employeId: emp.id, roles: emp.roles || [], plafondRemise: emp.plafondRemise };
      }
    }
  }
  return null;
}

function protegerAcces(req, res, next) {
  const superMotDePasse = process.env.ADMIN_PASSWORD;
  if (!superMotDePasse) {
    res.status(503).send(
      "Tableau de bord protege : la variable d'environnement ADMIN_PASSWORD n'est pas configuree sur " +
      "Render. Ajoutez-la (Environment > Add Environment Variable) pour activer l'acces a cette page."
    );
    return;
  }

  const payload = cryptoUtil.verifierJetonSession(lireCookie(req, NOM_COOKIE_SESSION));
  if (!payload) {
    res.status(401).json({ erreur: "Authentification requise." });
    return;
  }

  // Le jeton n'est qu'une PRETENTION signee par une session passee - on revalide ici contre les donnees EN
  // DIRECT (engines), jamais contre son seul contenu : les roles d'un employe en particulier sont toujours
  // relus depuis engines, jamais fait confiance au payload du jeton, pour qu'un retrait de role ou une
  // suppression de compte prenne effet immediatement, sans attendre l'expiration de la session en cours.
  let auth = null;
  if (payload.role === "superadmin") {
    const superUtilisateur = process.env.ADMIN_USER || "admin";
    if (payload.adminUser === superUtilisateur) auth = { role: "superadmin", merchantId: null, adminUser: superUtilisateur };
  } else if (payload.role === "marchand") {
    const entry = engines[payload.merchantId];
    if (entry && entry.merchant.adminUser && entry.merchant.adminUser === payload.adminUser) {
      auth = { role: "marchand", merchantId: payload.merchantId, adminUser: payload.adminUser };
    }
  } else if (payload.role === "employe") {
    const entry = engines[payload.merchantId];
    const emp = entry && (entry.merchant.employes || []).find((e) => e.id === payload.employeId);
    if (emp && emp.identifiant === payload.adminUser) {
      auth = { role: "employe", merchantId: payload.merchantId, adminUser: payload.adminUser, employeId: emp.id, roles: emp.roles || [], plafondRemise: emp.plafondRemise };
    }
  }

  if (!auth) {
    effacerCookieSession(res);
    res.status(401).json({ erreur: "Session invalide (compte modifie ou supprime) - veuillez vous reconnecter." });
    return;
  }

  req.auth = auth;
  // Session glissante : chaque requete authentifiee reussie reemet un cookie avec une nouvelle expiration a
  // 24h, pour qu'une utilisation active ne se fasse jamais deconnecter en plein travail.
  ecrireCookieSession(res, { role: auth.role, merchantId: auth.merchantId, adminUser: auth.adminUser, employeId: auth.employeId || null });
  next();
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

// Un service EXTERNE (IzyFacture) peut repondre 401 pour sa PROPRE raison (cle API invalide) - jamais a
// transmettre tel quel au navigateur /admin : depuis le 29 septembre 2026, l'interface traite TOUT 401 venu
// de NOTRE serveur comme "votre session a expire" (voir api() dans admin.html et protegerAcces plus haut),
// ce qui ferait a tort revenir a l'ecran de connexion alors que le probleme n'a rien a voir avec la session
// de la personne qui utilise /admin. Le message reste informatif (erreur.message/erreur.code cote client) -
// seul le code HTTP transmis au navigateur est requalifie pour ne jamais entrer en collision avec ce sens
// reserve. Utilise par les deux routes qui relaient une erreur IzyFacture (tester la cle, enregistrer un
// paiement) ci-dessous.
function statutReponseExterne(erreur) {
  const statut = erreur.status || 502;
  return statut === 401 ? 502 : statut;
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
  const entree = getMarchandOu404(req, res);
  return entree ? vuePourRequete(req, entree, permission) : entree;
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
// Jamais protegerAcces ici (29 septembre 2026, remplacement de l'authentification HTTP Basic) : la page
// elle-meme ne contient aucune donnee - elle affiche un ecran de connexion cote client des que
// GET /api/moi renvoie 401 (voir admin.html/afficherEcranConnexion). C'est la SEULE facon coherente de
// proceder avec un vrai formulaire de connexion : le navigateur ne doit jamais voir de popup native avant
// meme d'avoir pu charger la page qui contient ce formulaire.
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ---------------- Journal d'audit (Etape 40) ----------------
// Deux journaux, en ajout seul (voir db.js, table journal_audit) :
//   - MODIFICATIONS : qui a change quoi (catalogue avec avant/apres, parametres, employes, commandes...).
//   - CONNEXIONS : connexions reussies/echouees et deconnexions, avec adresse IP reelle (voir clientip.js).
// Lisibles UNIQUEMENT par le proprietaire du marchand (pour SES donnees) et par le super-administrateur
// (voir routes /journal plus bas) - jamais par un(e) employe(e). On ne journalise jamais un mot de passe,
// un jeton, une cle API ni le texte d'un message : seulement des resumes (champs touches, noms d'articles...).

// Actions reservees au super-administrateur : jamais montrees au marchand (il ne doit pas voir ces options).
const ACTIONS_SUPERADMIN_SEULEMENT = new Set([
  "marchand_cree", "marchand_supprime", "marchand_actif_modifie", "options_payantes_modifiees", "module_secondaire_modifie",
  "facturation_source_modifiee", "facturation_bascule", "cle_comptable_generee", "cle_comptable_revoquee"
]);

const LIBELLES_ACTIONS_AUDIT = {
  "POST /api/marchands": "marchand_cree",
  "PUT /api/:id/identifiants": "identifiants_modifies",
  "POST /api/:id/employes": "employe_cree",
  "PUT /api/:id/employes/:employeId": "employe_modifie",
  "DELETE /api/:id/employes/:employeId": "employe_supprime",
  "PUT /api/:id/actif": "marchand_actif_modifie",
  "PUT /api/marchands/:id/options-payantes": "options_payantes_modifiees",
  "PUT /api/marchands/:id/module-secondaire": "module_secondaire_modifie",
  "PUT /api/:id/facturation/source": "facturation_source_modifiee",
  "POST /api/:id/facturation/bascule": "facturation_bascule",
  "PUT /api/:id/facturation/parametres": "facturation_parametres_modifies",
  "POST /api/:id/facturation/factures": "facture_interne_creee",
  "POST /api/:id/facturation/factures/:fid/paiement": "paiement_interne_enregistre",
  "POST /api/:id/facturation/factures/:fid/avoir": "avoir_interne_cree",
  "POST /api/:id/facturation/factures/:fid/remboursement": "remboursement_interne_enregistre",
  "POST /api/:id/facturation/cle-comptable": "cle_comptable_generee",
  "DELETE /api/:id/facturation/cle-comptable": "cle_comptable_revoquee",
  "POST /api/:id/facturation/depenses": "depense_creee",
  "POST /api/:id/facturation/depenses/:did/annuler": "depense_annulee",
  "PUT /api/:id/izyfacture/parametres": "izyfacture_parametres_modifies",
  "POST /api/:id/izyfacture/tester": "izyfacture_testee",
  "POST /api/:id/commandes/:orderId/izyfacture/facturer": "facture_creee",
  "POST /api/:id/commandes/:orderId/izyfacture/paiement": "paiement_facture_enregistre",
  "POST /api/:id/rendezvous/:apptId/izyfacture/facturer": "facture_creee",
  "POST /api/:id/rendezvous/:apptId/izyfacture/paiement": "paiement_facture_enregistre",
  "PUT /api/marchands/:id/infos": "infos_marchand_modifiees",
  "DELETE /api/marchands/:id": "marchand_supprime",
  "PUT /api/:id/catalogue": "catalogue_modifie",
  "POST /api/:id/pos/vente": "vente_caisse",
  "POST /api/:id/pos/vente/:orderId/facture": "facture_caisse_creee",
  "POST /api/:id/caisse/session/ouvrir": "caisse_ouverte",
  "POST /api/:id/caisse/session/fermer": "caisse_fermee",
  "POST /api/:id/catalogue/importer": "catalogue_importe",
  "POST /api/:id/catalogue/:productId/photos": "photo_ajoutee",
  "DELETE /api/:id/catalogue/:productId/photos": "photo_supprimee",
  "POST /api/:id/services/:serviceId/photos": "photo_service_ajoutee",
  "DELETE /api/:id/services/:serviceId/photos": "photo_service_supprimee",
  "POST /api/:id/chambres/:chambreId/photos": "photo_chambre_ajoutee",
  "DELETE /api/:id/chambres/:chambreId/photos": "photo_chambre_supprimee",
  "PUT /api/:id/commandes/:orderId/statut": "commande_statut_modifie",
  "PUT /api/:id/commandes/:orderId/coordonnees": "commande_coordonnees_modifiees",
  "PUT /api/:id/services": "services_modifies",
  "POST /api/:id/services/importer": "services_importes",
  "PUT /api/:id/rendezvous/:apptId/deplacer": "rendezvous_deplace",
  "PUT /api/:id/rendezvous/:apptId/statut": "rendezvous_statut_modifie",
  "PUT /api/:id/chambres": "chambres_modifiees",
  "POST /api/:id/chambres/importer": "chambres_importees",
  "POST /api/:id/sejours": "sejour_cree",
  "PUT /api/:id/sejours/:sejourId/deplacer": "sejour_deplace",
  "PUT /api/:id/sejours/:sejourId/statut": "sejour_statut_modifie",
  "PUT /api/:id/transport/lignes": "transport_lignes_modifiees",
  "POST /api/:id/transport/lignes/:ligneId/generer-tarifs": "transport_tarifs_generes",
  "PUT /api/:id/transport/departs": "transport_departs_modifies",
  "POST /api/:id/transport/lignes/importer": "transport_lignes_importees",
  "POST /api/:id/transport/departs/importer": "transport_departs_importes",
  "PUT /api/:id/transport/reservations/:resId/statut": "transport_reservation_statut_modifie",
  "POST /api/:id/transport/reservations/:resId/envoyer-billet": "transport_billet_envoye",
  "POST /api/:id/transport/manifeste": "transport_manifeste_consulte",
  "POST /api/:id/transport/exemple": "transport_exemple_charge",
  "PUT /api/:id/parametres": "parametres_modifies",
  "PUT /api/:id/notification": "notification_modifiee",
  "PUT /api/:id/numeros-notification": "numeros_notification_modifies",
  "PUT /api/:id/numero-whatsapp-public": "numero_public_modifie",
  "PUT /api/:id/filigrane-logo": "filigrane_modifie",
  "POST /api/marchands/:id/tester-alerte": "alerte_testee",
  "POST /api/marchands/:id/logo": "logo_modifie",
  "DELETE /api/marchands/:id/logo": "logo_supprime",
  "POST /api/marchands/:id/image-accueil-whatsapp": "image_accueil_modifiee",
  "DELETE /api/marchands/:id/image-accueil-whatsapp": "image_accueil_supprimee",
  "POST /api/:id/conversations/:telephone/repondre": "reponse_manuelle_envoyee",
  "POST /api/:id/inventaire/instantanes": "inventaire_instantane_cree",
  "DELETE /api/:id/inventaire/instantanes/:snapshotId": "inventaire_instantane_supprime",
  "POST /api/:id/liste-attente/:entreeId/contacte": "client_attente_contacte",
  "PUT /api/:id/a-relancer/delai": "delai_relance_modifie",
  "POST /api/:id/a-relancer/marquer": "relance_marquee"
};

function cleCorpsAudit(corps) {
  return corps && typeof corps === "object" && !Array.isArray(corps) ? Object.keys(corps).slice(0, 30) : [];
}

// Resume NON sensible de la requete (jamais de valeur de mot de passe/cle/message) - la liste des champs
// touches suffit pour savoir "ce qui a ete modifie" sans exposer de secret.
function detailAuditRequete(code, req) {
  const b = req.body || {};
  const p = req.params || {};
  const entry = engines[p.id];
  const nomArticle = () => {
    const prod = entry && entry.moteurs.catalogue && entry.moteurs.catalogue.getCatalog().filter((x) => x.id === p.productId)[0];
    return prod ? prod.nom : null;
  };
  switch (code) {
    case "photo_ajoutee": case "photo_supprimee": return { art: nomArticle(), productId: p.productId || null };
    case "photo_service_ajoutee": case "photo_service_supprimee": {
      const sv = entry && entry.moteurs.service && entry.moteurs.service.getServices().filter((x) => x.id === p.serviceId)[0];
      return { elem: sv ? sv.nom : null };
    }
    case "photo_chambre_ajoutee": case "photo_chambre_supprimee": {
      const ch = entry && entry.moteurs.hebergement && entry.moteurs.hebergement.getChambres().filter((x) => x.id === p.chambreId)[0];
      return { elem: ch ? ch.nom : null };
    }
    case "commande_statut_modifie": return { commande: p.orderId, statut: b.statut || null };
    case "commande_coordonnees_modifiees": return { commande: p.orderId, champs: [b.telephone != null ? "telephone" : null, b.adresse != null ? "adresse" : null].filter(Boolean) };
    case "rendezvous_statut_modifie": return { rendezvous: p.apptId, statut: b.statut || null };
    case "rendezvous_deplace": return { rendezvous: p.apptId, date: b.date || null, heure: b.heure || null };
    case "sejour_statut_modifie": return { sejour: p.sejourId, statut: b.statut || null };
    case "sejour_deplace": return { sejour: p.sejourId, arrivee: b.arrivee || null, depart: b.depart || null };
    case "sejour_cree": return { arrivee: b.arrivee || null, depart: b.depart || null };
    case "transport_reservation_statut_modifie": return { reservation: p.resId, statut: b.statut || null };
    case "transport_billet_envoye": return { reservation: p.resId };
    case "transport_manifeste_consulte": return { depart: b.departId || null, date: b.date || null };
    case "transport_tarifs_generes": return { ligne: p.ligneId };
    case "transport_lignes_modifiees": return { lignes: Array.isArray(b) ? b.length : null };
    case "transport_departs_modifies": return { departs: Array.isArray(b) ? b.length : null };
    case "transport_lignes_importees": case "transport_departs_importes": return { fichier: req.file ? req.file.originalname : null };
    case "chambres_importees": return { fichier: req.file ? req.file.originalname : null };
    case "services_importes": return { fichier: req.file ? req.file.originalname : null };
    case "facture_creee": case "paiement_facture_enregistre":
      return p.apptId ? { rendezvous: p.apptId } : (p.orderId ? { commande: p.orderId } : {});
    case "vente_caisse_remise": return { tentative: "remise", motif: b.motifRemise || null };
    case "facture_caisse_creee": return { vente: p.orderId };
    case "employe_cree": return { employe: b.nom || null, roles: Array.isArray(b.roles) ? b.roles : null, plafondRemise: b.plafondRemise !== undefined ? b.plafondRemise : null };
    case "employe_modifie": {
      const emp = entry && (entry.merchant.employes || []).filter((e) => e.id === p.employeId)[0];
      return { employe: (emp && emp.nom) || p.employeId, roles: Array.isArray(b.roles) ? b.roles : null,
               motDePasse: !!(b.motDePasse || b.generer || b.genererMotDePasse) };
    }
    case "employe_supprime": return { employe: (res_locals_employe(entry, p.employeId)) };
    case "identifiants_modifies": return { motDePasse: !!(b.motDePasse || b.generer || b.genererMotDePasse), identifiant: !!b.adminUser };
    case "marchand_actif_modifie": return { actif: b.actif };
    case "numeros_notification_modifies": return { nombre: Array.isArray(b.numeros) ? b.numeros.length : null };
    case "options_payantes_modifiees": return { options: b };
    case "module_secondaire_modifie": return { moduleSecondaire: (Array.isArray(b.modulesSecondaires) ? b.modulesSecondaires.join(",") : (Array.isArray(b.moduleSecondaire) ? b.moduleSecondaire.join(",") : (b.modulesSecondaires || b.moduleSecondaire))) || null };
    case "facturation_source_modifiee": return { source: b.source || null };
    case "facturation_bascule": return {};
    case "paiement_interne_enregistre": case "avoir_interne_cree": case "remboursement_interne_enregistre": return { facture: p.fid, montant: b.montant != null ? Number(b.montant) || null : null };
    case "depense_creee": return { categorie: b.categorie || null, montant: Number(b.montant) || null };
    case "depense_annulee": return { depense: p.did };
    case "facture_interne_creee": return { lignes: Array.isArray(b.lignes) ? b.lignes.length : null };
    case "reponse_manuelle_envoyee": return { telephone: p.telephone };
    case "client_attente_contacte": return { entree: p.entreeId };
    case "inventaire_instantane_supprime": return { instantane: p.snapshotId };
    case "catalogue_importe": return { fichier: req.file ? req.file.originalname : null };
    case "vente_caisse": return Object.assign({ lignes: Array.isArray(b.lignes) ? b.lignes.length : null, modePaiement: b.modePaiement || null },
      (b.remiseGlobale || b.motifRemise || (Array.isArray(b.lignes) && b.lignes.some((l) => l && l.remise))) ? { tentativeRemise: true, motif: b.motifRemise || null } : {});
    case "parametres_modifies": {
      // Etape 67 : la regle d'annulation est une decision metier (le super-administrateur l'aide a la regler) :
      // le journal garde ses VALEURS, pas seulement le nom des champs.
      const d = { champs: cleCorpsAudit(b) };
      if (b.delaiAnnulationHeures !== undefined) d.delaiAnnulationHeures = Number(b.delaiAnnulationHeures) || 0;
      if (b.modeDelaiDepasse !== undefined) d.modeDelaiDepasse = b.modeDelaiDepasse === "accepter" ? "accepter" : "refuser";
      if (b.listesDatesHeures !== undefined) d.listesDatesHeures = !(b.listesDatesHeures === false || b.listesDatesHeures === "false" || b.listesDatesHeures === 0); // Etape 68
      return d;
    }
    case "infos_marchand_modifiees": case "izyfacture_parametres_modifies":
    case "services_modifies": case "logo_modifie": case "image_accueil_modifiee":
      return { champs: cleCorpsAudit(b) };
    default: return {};
  }
}
function res_locals_employe(entry, employeId) {
  const emp = entry && (entry.merchant.employes || []).filter((e) => e.id === employeId)[0];
  return (emp && emp.nom) || employeId;
}

function acteurAudit(req) {
  const a = req.auth;
  const entry = a.merchantId && engines[a.merchantId];
  let nom = a.adminUser;
  if (a.role === "employe" && entry) {
    const emp = (entry.merchant.employes || []).filter((e) => e.id === a.employeId)[0];
    if (emp && emp.nom) nom = emp.nom + " (" + a.adminUser + ")";
  }
  return { acteurRole: a.role, acteurNom: nom, acteurId: a.employeId || a.adminUser };
}

function ipAudit(req) { return req.ip || (req.socket && req.socket.remoteAddress) || null; }
function uaAudit(req) { return req.get("user-agent") || null; }

app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  res.on("finish", () => {
    try {
      if (!req.auth || !req.route) return;                       // non authentifie (401) : rien a journaliser
      if (res.statusCode >= 400 && res.statusCode !== 403) return; // erreurs de saisie/serveur : pas des actions
      const cle = req.method + " " + req.route.path;
      const code = LIBELLES_ACTIONS_AUDIT[cle];
      if (!code) return;                                         // simulateur, connexion/deconnexion (journalises a part)...
      const acteur = acteurAudit(req);
      // Un marchand/employe est toujours journalise sous SON propre marchand (jamais sous celui qu'il aurait
      // vise par une URL falsifiee : il ne doit pas pouvoir polluer le journal d'un autre) ; le
      // super-administrateur sous le marchand concerne.
      let merchantKey = req.auth.role === "superadmin" ? (req.params.id || "") : (req.auth.merchantId || "");
      if (res.locals.audit && res.locals.audit.merchantKey !== undefined) merchantKey = res.locals.audit.merchantKey;
      if (res.statusCode === 403) {
        const detail = Object.assign({}, detailAuditRequete(code, req), req.params.id && req.params.id !== merchantKey ? { cible: req.params.id } : {});
        db.journalAjouter(Object.assign({ type: "modification", merchantKey, action: code, statut: "refuse",
          detail: JSON.stringify(detail), ip: ipAudit(req), userAgent: uaAudit(req) }, acteur));
        return;
      }
      if (res.locals.audit && res.locals.audit.ignorer) return;  // ex: catalogue enregistre sans aucun changement reel
      const detail = (res.locals.audit && res.locals.audit.detail) || detailAuditRequete(code, req);
      db.journalAjouter(Object.assign({ type: "modification", merchantKey, action: code, statut: "ok",
        detail: JSON.stringify(detail), ip: ipAudit(req), userAgent: uaAudit(req) }, acteur));
      (res.locals.auditExtra || []).forEach((x) => {
        db.journalAjouter(Object.assign({ type: "modification", merchantKey, action: x.action, statut: x.statut || "refuse",
          detail: JSON.stringify(x.detail || {}), ip: ipAudit(req), userAgent: uaAudit(req) }, acteur));
      });
    } catch (e) { console.error("Journal d'audit (middleware) :", e); }
  });
  next();
});

// ---- Comparaison avant/apres d'un catalogue (PUT /api/:id/catalogue) : uniquement les VRAIS changements ----
function texteAudit(v) {
  if (v === undefined || v === null || v === "") return "";
  return String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 80);
}
function cleVarianteAudit(v, i) { return (v.couleur || "") + "|" + (v.taille || ""); }

function comparerCatalogues(avant, apres) {
  const changes = [];
  const parId = new Map();
  (avant || []).forEach((p) => { if (p && p.id) parId.set(p.id, p); });
  const idsApres = new Set();
  (apres || []).forEach((p) => {
    if (!p || !p.id) { changes.push({ k: "article_ajoute", art: texteAudit(p && p.nom) }); return; }
    idsApres.add(p.id);
    const a = parId.get(p.id);
    if (!a) { changes.push({ k: "article_ajoute", art: texteAudit(p.nom) }); return; }
    const art = texteAudit(a.nom || p.nom);
    const champs = new Set(Object.keys(a).concat(Object.keys(p)));
    champs.forEach((c) => {
      if (c === "variantes" || c === "photos" || c === "id") return;
      if (texteAudit(a[c]) !== texteAudit(p[c])) changes.push({ k: "champ", art, champ: c, de: texteAudit(a[c]), a: texteAudit(p[c]) });
    });
    const va = new Map(); (a.variantes || []).forEach((v, i) => va.set(cleVarianteAudit(v) + "#" + [...va.keys()].filter((k) => k.indexOf(cleVarianteAudit(v) + "#") === 0).length, v));
    const vp = new Map(); (p.variantes || []).forEach((v, i) => vp.set(cleVarianteAudit(v) + "#" + [...vp.keys()].filter((k) => k.indexOf(cleVarianteAudit(v) + "#") === 0).length, v));
    vp.forEach((v, k) => {
      const lib = ((v.couleur || "") + " " + (v.taille || "")).trim();
      const o = va.get(k);
      if (!o) { changes.push({ k: "variante_ajoutee", art, v: lib }); return; }
      new Set(Object.keys(o).concat(Object.keys(v))).forEach((c) => {
        if (c === "stockVirtuel") return; // valeur calculee, jamais une modification
        if (texteAudit(o[c]) !== texteAudit(v[c])) changes.push({ k: "variante_champ", art, v: lib, champ: c, de: texteAudit(o[c]), a: texteAudit(v[c]) });
      });
    });
    va.forEach((v, k) => { if (!vp.has(k)) changes.push({ k: "variante_supprimee", art, v: ((v.couleur || "") + " " + (v.taille || "")).trim() }); });
    const pa = a.photos || [], pp = p.photos || [];
    const ajout = pp.filter((u) => pa.indexOf(u) === -1).length, retir = pa.filter((u) => pp.indexOf(u) === -1).length;
    if (ajout || retir) changes.push({ k: "photos", art, ajoutees: ajout, retirees: retir });
  });
  parId.forEach((a, id) => { if (!idsApres.has(id)) changes.push({ k: "article_supprime", art: texteAudit(a.nom) }); });
  return changes;
}

// Filet "employe" pour le catalogue : un(e) employe(e) ne peut ni supprimer d'article (deja gere),
// ni retirer une variante, ni retirer une photo - meme par appel direct a l'API. Retourne le catalogue
// corrige + la liste de ce qui a ete restaure (pour le journal : tentative bloquee).
function appliquerFiletEmployeCatalogue(actuel, soumis) {
  const restaures = [];
  const parId = new Map();
  (actuel || []).forEach((p) => { if (p && p.id) parId.set(p.id, p); });
  const corrige = (soumis || []).map((p) => {
    const a = p && p.id ? parId.get(p.id) : null;
    if (!a) return p;
    const copie = Object.assign({}, p);
    // Variantes : si le nombre diminue, on remet les variantes manquantes (jusqu'au nombre retire - une
    // simple RENOMMEE de variante ne change pas le nombre et reste donc acceptee, sans doublon).
    const vSoumises = Array.isArray(p.variantes) ? p.variantes : [];
    const vActuelles = Array.isArray(a.variantes) ? a.variantes : [];
    if (vSoumises.length < vActuelles.length) {
      const cles = new Set(vSoumises.map((v) => cleVarianteAudit(v)));
      const manquantes = vActuelles.filter((v) => !cles.has(cleVarianteAudit(v))).slice(0, vActuelles.length - vSoumises.length);
      if (manquantes.length) {
        copie.variantes = vSoumises.concat(manquantes);
        manquantes.forEach((v) => restaures.push({ k: "variante_supprimee", art: texteAudit(a.nom), v: ((v.couleur || "") + " " + (v.taille || "")).trim() }));
      }
    }
    // Photos : on garde toutes celles du serveur ; les nouvelles (ajoutees via la route d'envoi) restent.
    const phSoumises = Array.isArray(p.photos) ? p.photos : [];
    const phActuelles = Array.isArray(a.photos) ? a.photos : [];
    const retirees = phActuelles.filter((u) => phSoumises.indexOf(u) === -1);
    if (retirees.length) {
      copie.photos = phActuelles.concat(phSoumises.filter((u) => phActuelles.indexOf(u) === -1));
      restaures.push({ k: "photos", art: texteAudit(a.nom), retirees: retirees.length });
    }
    return copie;
  });
  return { catalogue: corrige, restaures };
}


// Qui est-ce (pour le journal des connexions) : un super-administrateur est journalise au niveau GLOBAL
// (merchantKey "" - jamais visible d'un marchand), un marchand/employe sous son marchand.
function descriptionActeurConnexion(a) {
  const entry = a.merchantId && engines[a.merchantId];
  let nom = a.adminUser;
  if (a.role === "employe" && entry) {
    const emp = (entry.merchant.employes || []).filter((e) => e.id === a.employeId)[0];
    if (emp && emp.nom) nom = emp.nom + " (" + a.adminUser + ")";
  }
  return { merchantKey: a.role === "superadmin" ? "" : (a.merchantId || ""), acteurRole: a.role, acteurNom: nom, acteurId: a.employeId || a.adminUser };
}

// Pour un echec de connexion : retrouve le compte reel portant cet identifiant (ou null).
function trouverCompteParIdentifiant(identifiant) {
  if (identifiant === (process.env.ADMIN_USER || "admin")) return { merchantKey: "", role: "superadmin", nom: identifiant };
  for (const id of Object.keys(engines)) {
    const m = engines[id].merchant;
    if (m.adminUser && m.adminUser === identifiant) return { merchantKey: id, role: "marchand", nom: identifiant };
    const emp = (m.employes || []).filter((e) => e.identifiant && e.identifiant === identifiant)[0];
    if (emp) return { merchantKey: id, role: "employe", nom: (emp.nom || "") + " (" + identifiant + ")" };
  }
  return null;
}

// ---------------- API d'administration (protegee) ----------------

// Connexion (29 septembre 2026, remplace l'authentification HTTP Basic) : verifie les identifiants fournis
// et, si valides, pose un cookie de session (voir ecrireCookieSession plus haut). VOLONTAIREMENT SANS
// protegerAcces sur cette route - c'est justement elle qui etablit l'identite, il n'y a encore rien a
// verifier au moment ou elle est appelee.
app.post("/api/connexion", (req, res) => {
  if (!process.env.ADMIN_PASSWORD) {
    res.status(503).json({ erreur: "ADMIN_PASSWORD n'est pas configuree sur le serveur." });
    return;
  }
  const { identifiant, motDePasse } = req.body || {};
  if (!identifiant || !motDePasse) {
    res.status(400).json({ erreur: "Identifiant et mot de passe requis." });
    return;
  }
  const auth = identifierCompte(String(identifiant), String(motDePasse));
  if (!auth) {
    // Journal des connexions : on ne retient l'identifiant tape que s'il correspond a un compte REEL (sinon
    // quelqu'un qui colle son mot de passe dans le champ identifiant le verrait ecrit dans le journal).
    const cible = trouverCompteParIdentifiant(String(identifiant));
    db.journalAjouter({ type: "connexion", merchantKey: cible ? cible.merchantKey : "", acteurRole: cible ? cible.role : null,
      acteurNom: cible ? cible.nom : null, acteurId: null, action: "connexion_echec", statut: "echec", ip: ipAudit(req), userAgent: uaAudit(req) });
    res.status(401).json({ erreur: "Identifiant ou mot de passe incorrect." });
    return;
  }
  db.journalAjouter(Object.assign({ type: "connexion", action: "connexion_ok", statut: "ok", ip: ipAudit(req), userAgent: uaAudit(req) },
    descriptionActeurConnexion(auth)));
  ecrireCookieSession(res, { role: auth.role, merchantId: auth.merchantId, adminUser: auth.adminUser, employeId: auth.employeId || null });
  res.json({ role: auth.role, merchantId: auth.merchantId, adminUser: auth.adminUser, roles: auth.roles || null, plafondRemise: auth.role === "employe" ? remisesLib.plafondEmploye(auth.plafondRemise) : null });
});

// Deconnexion : efface le cookie de session. Reussit toujours, meme sans cookie present ou deja expire -
// du point de vue du client, se deconnecter ne doit jamais echouer.
app.post("/api/deconnexion", (req, res) => {
  const payload = cryptoUtil.verifierJetonSession(lireCookie(req, NOM_COOKIE_SESSION));
  if (payload) {
    db.journalAjouter(Object.assign({ type: "connexion", action: "deconnexion", statut: "ok", ip: ipAudit(req), userAgent: uaAudit(req) },
      descriptionActeurConnexion({ role: payload.role, merchantId: payload.merchantId || null, adminUser: payload.adminUser, employeId: payload.employeId || null })));
  }
  effacerCookieSession(res);
  res.json({ ok: true });
});

// -- Journaux (Etape 40) : modifications + connexions. Lecture seule, reservee au PROPRIETAIRE du marchand
// (pour ses propres donnees) et au super-administrateur - jamais a un(e) employe(e), meme avec tous les roles.
// Au marchand, on masque les actions reservees au super-administrateur (options payantes, suspension...) et
// l'identite/IP du super-administrateur : il ne doit pas voir ces options (voir ACTIONS_SUPERADMIN_SEULEMENT). --
function filtrerJournalPourDemandeur(req, lignes) {
  if (req.auth.role === "superadmin") return lignes;
  return lignes
    .filter((l) => !ACTIONS_SUPERADMIN_SEULEMENT.has(l.action) && l.acteurRole !== "superadmin")
    .map((l) => ({ id: l.id, type: l.type, action: l.action, statut: l.statut, acteurRole: l.acteurRole, acteurNom: l.acteurNom,
      detail: l.detail, ip: l.ip, userAgent: l.userAgent, horodatageISO: l.horodatageISO }));
}

async function repondreJournal(req, res, type) {
  const id = req.params.id;
  if (!verifierPortee(req, res, id)) return;
  if (!estGestionnaireDuMarchand(req, id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  if (!engines[id]) return res.status(404).json({ erreur: "Marchand inconnu : " + id });
  try {
    const limite = Math.max(1, Math.min(200, parseInt(req.query.limite, 10) || 100));
    const brutes = await db.journalLister({ type, merchantKey: id, limite, avantId: req.query.avant });
    const lignes = filtrerJournalPourDemandeur(req, brutes);
    res.json({ lignes, suivant: brutes.length === limite ? brutes[brutes.length - 1].id : null });
  } catch (erreur) {
    console.error("Journal (lecture) :", erreur);
    res.status(500).json({ erreur: "Lecture du journal impossible." });
  }
}
app.get("/api/:id/journal/modifications", protegerAcces, (req, res) => repondreJournal(req, res, "modification"));
app.get("/api/:id/journal/connexions", protegerAcces, (req, res) => repondreJournal(req, res, "connexion"));

// Vue globale (tous les marchands + evenements hors marchand : creation de marchand, connexions du
// super-administrateur...) : super-administrateur UNIQUEMENT.
app.get("/api/journal/global", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  try {
    const type = req.query.type === "connexion" ? "connexion" : "modification";
    const limite = Math.max(1, Math.min(200, parseInt(req.query.limite, 10) || 100));
    const brutes = await db.journalLister({ type, limite, avantId: req.query.avant });
    const lignes = brutes.map((l) => Object.assign({}, l, { marchandNom: l.merchantKey && engines[l.merchantKey] ? engines[l.merchantKey].merchant.nom : null }));
    res.json({ lignes, suivant: brutes.length === limite ? brutes[brutes.length - 1].id : null });
  } catch (erreur) {
    console.error("Journal global (lecture) :", erreur);
    res.status(500).json({ erreur: "Lecture du journal impossible." });
  }
});

// Le super-administrateur voit tous les marchands ; un marchand ne voit que lui-meme (l'interface
// n'affiche donc jamais a un marchand la liste des autres marchands, meme leur nom).
app.get("/api/marchands", protegerAcces, (req, res) => {
  const tous = Object.values(engines).map((e) => ({
    id: e.merchant.id, nom: e.merchant.nom, type: e.merchant.type, adminUser: e.merchant.adminUser || null,
    moduleSecondaire: modulesDuMarchand(e.merchant)[1] || null, modulesSecondaires: modulesDuMarchand(e.merchant).slice(1), modules: modulesDuMarchand(e.merchant),
    phoneNotification: e.merchant.phoneNotification || null, actif: e.merchant.actif !== false,
    // Etape 76 : quota (fixe par le seul super-administrateur ; 0 = option fermee) et liste des numeros d'alerte supplementaires.
    nbNumerosNotificationSupp: quotaNumerosSupp(e.merchant),
    numerosNotificationSupp: quotaNumerosSupp(e.merchant) > 0 || req.auth.role === "superadmin" ? (Array.isArray(e.merchant.numerosNotificationSupp) ? e.merchant.numerosNotificationSupp : []) : [],
    plafondNumerosNotificationSupp: PLAFOND_NUMEROS_NOTIFICATION_SUPP,
    logoUrl: e.merchant.logoUrl || null, imageAccueilWhatsappUrl: e.merchant.imageAccueilWhatsappUrl || null,
    numeroWhatsappPublic: e.merchant.numeroWhatsappPublic || null,
    optionStockIllimite: e.merchant.optionStockIllimite === true, optionLienCommande: e.merchant.optionLienCommande === true,
    optionNotificationsStatut: e.merchant.optionNotificationsStatut === true,
    // "Facturation IzyFacture" (option payante, 26 septembre 2026 - meme principe que les 3 precedentes) :
    // tant que le super-administrateur ne l'a pas debloquee ici, le bloc entier reste invisible cote
    // marchand (voir admin.html) ET les routes /api/:id/izyfacture/* refusent toute action (voir plus bas).
    optionFacturationIzyfacture: e.merchant.optionFacturationIzyfacture === true,
    // Jamais la cle elle-meme ici (chiffree ou non) - seulement de quoi savoir, cote /admin, si le pont
    // IzyFacture est configure pour ce marchand (voir /api/:id/izyfacture/parametres pour le detail,
    // reserve au proprietaire/super-administrateur).
    izyfactureConfiguree: !!e.merchant.izyfactureApiKey,
    // Etape 54 : source de facturation choisie par le super-administrateur ("aucune"/"interne"/"izyfacture").
    // Le marchand en voit seulement le RESULTAT (colonnes Facture, onglet Facturation) ; le selecteur et la
    // bascule n'existent que dans l'interface du super-administrateur, et leurs routes lui sont reservees.
    sourceFacturation: sourceFacturation(e),
    facturationInterneVisible: facturationInterneVisible(e),
    facturationInterneAuto: !!e.facturation && e.facturation.config().autoFacturation === true,
    dateBasculeFacturation: e.facturation ? e.facturation.config().dateBascule || null : null,
    izyfactureAutoFacturation: e.merchant.izyfactureAutoFacturation === true,
    // Dernier echec de LIVRAISON reel d'une alerte, signale par Meta apres coup (voir POST /webhook,
    // traitement de "statuses", Etape 25) - distinct du resultat du bouton "Tester l'alerte maintenant"
    // (qui ne voit qu'un echec immediat d'ENVOI, jamais un echec de livraison survenant juste apres).
    derniereErreurAlerte: e.merchant.derniereErreurAlerte || null,
    // Filigrane du logo en arriere-plan de /admin (29 septembre 2026, voir PUT /api/:id/filigrane-logo plus
    // bas) - actif par defaut des qu'un logo existe (colonne DEFAULT true), desactivable au cas par cas par
    // le marchand. "!== false" et non "=== true" : un marchand qui ne l'a JAMAIS reglee doit rester actif
    // par defaut (contrairement aux options payantes ci-dessus, volontairement l'inverse).
    filigraneLogoActif: e.merchant.filigraneLogoActif !== false,
    // "Caisse POS" (option payante, 29 septembre 2026 - meme principe que les 4 precedentes) : tant que le
    // super-administrateur ne l'a pas debloquee ici, l'onglet Caisse reste invisible cote marchand (voir
    // admin.html) ET POST /api/:id/pos/vente refuse toute action (voir plus bas).
    optionCaissePos: e.merchant.optionCaissePos === true
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
  const { id, nom, type, phoneNumberId, adminUser, adminPassword, phoneNotification, moduleSecondaire } = req.body || {};
  if (!id || !nom || !type) return res.status(400).json({ erreur: "id, nom et type sont requis." });
  if (type !== "catalogue" && type !== "service" && type !== "hebergement" && type !== "transport") return res.status(400).json({ erreur: "type doit être 'catalogue', 'service', 'hebergement' ou 'transport'." });
  // Marchand HYBRIDE (Etape 48, generalise a trois volets a l'Etape 66) : volets secondaires accordes des la
  // creation - reserve au super-administrateur (cette route l'est deja en entier), jamais deductible d'une
  // autre source.
  const demandeSecondaires = lireDemandeSecondaires(moduleSecondaire, type);
  if (demandeSecondaires.erreur) return res.status(400).json({ erreur: demandeSecondaires.erreur });
  if (engines[id]) return res.status(409).json({ erreur: "Un marchand avec cet id existe déjà." });
  if (!adminUser || !adminPassword) return res.status(400).json({ erreur: "adminUser et adminPassword sont requis pour créer les identifiants de connexion du marchand." });
  const merchant = {
    id, nom, type,
    phoneNumberId: phoneNumberId || null,
    adminUser,
    adminPassword: bcrypt.hashSync(String(adminPassword), 10),
    phoneNotification: phoneNotification || null,
    moduleSecondaire: demandeSecondaires.liste.join(",") || null,
    // Marchand tout juste cree : n'a jamais connu l'ancien regroupement de roles employe (commandes dans
    // conversations, tableaudebord/rapports dans parametres - voir migrerRolesEmployes dans db.js), donc
    // rien a migrer pour lui. Sans ce marquage explicite, un futur redemarrage du serveur risquerait de
    // "corriger" les roles d'un de ses employes vers un regroupement qui n'a jamais existe pour ce marchand.
    rolesMigres: db.CLES_MIGRATIONS_ROLES_CONNUES
  };
  await db.addMerchant(merchant);
  engines[id] = await construireEntree(merchant);
  if (merchant.phoneNumberId) phoneNumberIndex[merchant.phoneNumberId] = id;
  console.log("Nouveau marchand ajoute via l'API : " + id + " (" + type + ")");
  res.status(201).json({ id: merchant.id, nom: merchant.nom, type: merchant.type, adminUser: merchant.adminUser, moduleSecondaire: merchant.moduleSecondaire });
});

// Qui suis-je ? Utilise par l'interface d'administration pour savoir si l'utilisateur connecte est le
// super-administrateur (acces a tout, gestion des marchands et de leurs identifiants) ou un marchand
// (limite a ses propres donnees, peut seulement changer son propre mot de passe).
app.get("/api/moi", protegerAcces, (req, res) => {
  res.json({ role: req.auth.role, merchantId: req.auth.merchantId, adminUser: req.auth.adminUser, roles: req.auth.roles || null, plafondRemise: req.auth.role === "employe" ? remisesLib.plafondEmploye(req.auth.plafondRemise) : null });
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

// Etape 59 : le droit « remises » n'a de sens qu'avec la Caisse ou la Facturation ; plafond en % propre a l'employe.
function erreurRolesRemises(roles) {
  return roles.indexOf("remises") !== -1 && roles.indexOf("caisse") === -1 && roles.indexOf("facturation") === -1
    ? "Le droit « Remises » doit s'accompagner du rôle Caisse ou Facturation." : null;
}
function lirePlafondRemise(v) {
  if (v === undefined) return { valeur: undefined };
  const n = Number(v);
  if (v === null || v === "" || !Number.isFinite(n) || n < 0 || n > 100) return { erreur: "Plafond de remise invalide (entre 0 et 100 %)." };
  return { valeur: Math.round(n * 100) / 100 };
}
app.get("/api/:id/employes", protegerAcces, (req, res) => {
  const id = req.params.id;
  if (!verifierPortee(req, res, id)) return;
  if (!estGestionnaireDuMarchand(req, id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  res.json((entry.merchant.employes || []).map((e) => ({ id: e.id, nom: e.nom, identifiant: e.identifiant, roles: e.roles || [], plafondRemise: (e.roles || []).indexOf("remises") !== -1 ? remisesLib.plafondEmploye(e.plafondRemise) : null })));
});

app.post("/api/:id/employes", protegerAcces, async (req, res) => {
  const id = req.params.id;
  if (!verifierPortee(req, res, id)) return;
  if (!estGestionnaireDuMarchand(req, id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  const entry = getMarchandOu404(req, res); if (!entry) return;

  const { nom, identifiant, motDePasse, roles, plafondRemise } = req.body || {};
  const plafondLu = lirePlafondRemise(plafondRemise);
  if (plafondLu.erreur) return res.status(400).json({ erreur: plafondLu.erreur });
  if (!nom || !String(nom).trim()) return res.status(400).json({ erreur: "nom requis." });
  if (!identifiant || !String(identifiant).trim()) return res.status(400).json({ erreur: "identifiant requis." });
  if (!motDePasse || String(motDePasse).length < 6) return res.status(400).json({ erreur: "motDePasse requis (6 caractères minimum)." });

  const rolesDemandes = Array.isArray(roles) ? roles.filter((r) => ROLES_EMPLOYE_VALIDES.indexOf(r) !== -1) : [];
  if (!rolesDemandes.length) return res.status(400).json({ erreur: "Au moins un rôle est requis." });
  const rolesIncompatibles = rolesDemandes.filter((r) =>
    (r === "catalogue" && !entry.moteurs.catalogue) || (r === "rendezvous" && !entry.moteurs.service && !entry.moteurs.hebergement && !entry.moteurs.transport)
  );
  if (rolesIncompatibles.length) {
    return res.status(400).json({ erreur: "Rôle(s) non compatible(s) avec le type de ce marchand : " + rolesIncompatibles.join(", ") + "." });
  }
  const erreurRemises = erreurRolesRemises(rolesDemandes);
  if (erreurRemises) return res.status(400).json({ erreur: erreurRemises });
  if (rolesDemandes.indexOf("remises") !== -1 && plafondLu.valeur === undefined) {
    return res.status(400).json({ erreur: "Indiquez le plafond de remise de cet employé (0 à 100 %) : aucune remise n'est accordée par défaut." });
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
  if (rolesDemandes.indexOf("remises") !== -1) employe.plafondRemise = plafondLu.valeur;
  const ajoute = await db.addEmploye(id, employe);
  if (!ajoute) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.employes = entry.merchant.employes || [];
  entry.merchant.employes.push(employe);

  console.log(`[${id}] Nouvel employé créé par ${req.auth.adminUser} : ${employe.identifiant} (${employe.roles.join(", ")}).`);
  res.status(201).json({ id: employe.id, nom: employe.nom, identifiant: employe.identifiant, roles: employe.roles, plafondRemise: employe.plafondRemise !== undefined ? employe.plafondRemise : null });
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
    if (req.body && (req.body.nom !== undefined || req.body.roles !== undefined || req.body.plafondRemise !== undefined)) {
      return res.status(403).json({ erreur: "Seul le propriétaire du marchand peut changer le nom ou les rôles d'un compte employé." });
    }
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ erreur: "Le mot de passe doit contenir au moins 6 caractères." });
    motDePasseEnClair = String(newPassword);
    patch.motDePasseHash = bcrypt.hashSync(motDePasseEnClair, 10);
  } else if (estGestionnaireDuMarchand(req, id)) {
    const { nom, roles, newPassword, genererMotDePasse, plafondRemise } = req.body || {};
    const plafondLu = lirePlafondRemise(plafondRemise);
    if (plafondLu.erreur) return res.status(400).json({ erreur: plafondLu.erreur });
    if (nom !== undefined) {
      if (!String(nom).trim()) return res.status(400).json({ erreur: "Le nom ne peut pas être vide." });
      patch.nom = String(nom).trim();
    }
    if (roles !== undefined) {
      const rolesDemandes = Array.isArray(roles) ? roles.filter((r) => ROLES_EMPLOYE_VALIDES.indexOf(r) !== -1) : [];
      if (!rolesDemandes.length) return res.status(400).json({ erreur: "Au moins un rôle est requis." });
      const rolesIncompatibles = rolesDemandes.filter((r) =>
        (r === "catalogue" && !entry.moteurs.catalogue) || (r === "rendezvous" && !entry.moteurs.service && !entry.moteurs.hebergement && !entry.moteurs.transport)
      );
      if (rolesIncompatibles.length) {
        return res.status(400).json({ erreur: "Rôle(s) non compatible(s) avec le type de ce marchand : " + rolesIncompatibles.join(", ") + "." });
      }
      const erreurRemises = erreurRolesRemises(rolesDemandes);
      if (erreurRemises) return res.status(400).json({ erreur: erreurRemises });
      patch.roles = rolesDemandes;
    }
    if (plafondLu.valeur !== undefined) patch.plafondRemise = plafondLu.valeur;
    if (patch.roles && patch.roles.indexOf("remises") !== -1 && patch.plafondRemise === undefined && employeActuel.plafondRemise === undefined) return res.status(400).json({ erreur: "Indiquez le plafond de remise de cet employé (0 à 100 %) : aucune remise n'est accordée par défaut." });
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
  res.json({ id: maj.id, nom: maj.nom, identifiant: maj.identifiant, roles: maj.roles, plafondRemise: maj.plafondRemise !== undefined ? maj.plafondRemise : null, nouveauMotDePasse: motDePasseEnClair || undefined });
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

// -- Options payantes par marchand (demandees le 15 septembre 2026) : "Stock illimite" (case a cocher par
// article dans le Catalogue) et "Lien de commande" (numero WhatsApp public + bouton "Copier le lien" par
// article) sont des ameliorations qu'IzyVendeur n'offrait pas a l'origine - reservees, chacune
// independamment, aux marchands pour qui le super-administrateur les debloque explicitement ici. Reserve
// au super-administrateur, exactement comme la suspension ci-dessus - un marchand ne peut jamais se les
// debloquer lui-meme, meme via son propre acces "parametres". Voir aussi le filtrage cote
// PUT /api/:id/catalogue et PUT /api/:id/numero-whatsapp-public ci-dessous, qui empechent un contournement
// par appel direct a l'API tant que l'option n'est pas debloquee. --
app.put("/api/marchands/:id/options-payantes", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = engines[req.params.id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + req.params.id });
  const { optionStockIllimite, optionLienCommande, optionNotificationsStatut, optionFacturationIzyfacture, optionCaissePos, nbNumerosNotification } = req.body || {};
  const patch = {};
  // Etape 76 : nombre de numeros d'alerte supplementaires accordes a ce marchand (0 = option fermee). Reserve au super-administrateur
  // (toute la route l'est) ; le marchand remplit ensuite la liste dans cette limite (PUT /api/:id/numeros-notification).
  if (nbNumerosNotification !== undefined) {
    const n = Number(nbNumerosNotification);
    if (!Number.isInteger(n) || n < 0 || n > PLAFOND_NUMEROS_NOTIFICATION_SUPP) {
      return res.status(400).json({ erreur: "nbNumerosNotification doit être un entier entre 0 et " + PLAFOND_NUMEROS_NOTIFICATION_SUPP + "." });
    }
    patch.nbNumerosNotificationSupp = n;
  }
  if (optionStockIllimite !== undefined) patch.optionStockIllimite = !!optionStockIllimite;
  if (optionLienCommande !== undefined) patch.optionLienCommande = !!optionLienCommande;
  if (optionNotificationsStatut !== undefined) patch.optionNotificationsStatut = !!optionNotificationsStatut;
  if (optionFacturationIzyfacture !== undefined) {
    // Etape 54 : une seule source de facturation a la fois. Activer IzyFacture alors que la facturation
    // integree est active ne se fait que par la bascule (sens unique) - voir PUT /facturation/source.
    if (optionFacturationIzyfacture && sourceFacturation(entry) === "interne") {
      return res.status(409).json({ erreur: "La facturation intégrée est active : utilisez le choix de source (bascule) plutôt que cette case." });
    }
    patch.optionFacturationIzyfacture = !!optionFacturationIzyfacture;
  }
  if (optionCaissePos !== undefined) patch.optionCaissePos = !!optionCaissePos;
  if (!Object.keys(patch).length) return res.status(400).json({ erreur: "Rien à modifier." });
  const maj = await db.updateMerchantFields(req.params.id, patch);
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.optionStockIllimite = maj.optionStockIllimite;
  entry.merchant.optionLienCommande = maj.optionLienCommande;
  entry.merchant.optionNotificationsStatut = maj.optionNotificationsStatut;
  entry.merchant.optionFacturationIzyfacture = maj.optionFacturationIzyfacture;
  entry.merchant.optionCaissePos = maj.optionCaissePos;
  entry.merchant.nbNumerosNotificationSupp = maj.nbNumerosNotificationSupp;
  console.log(`[${req.params.id}] Options payantes mises à jour par ${req.auth.adminUser} : stock illimité=${maj.optionStockIllimite}, lien de commande=${maj.optionLienCommande}, notifications de statut=${maj.optionNotificationsStatut}, facturation IzyFacture=${maj.optionFacturationIzyfacture}, caisse POS=${maj.optionCaissePos}, numéros d'alerte supplémentaires=${quotaNumerosSupp(maj)}.`);
  res.json({ id: req.params.id, nbNumerosNotification: quotaNumerosSupp(maj), optionStockIllimite: maj.optionStockIllimite, optionLienCommande: maj.optionLienCommande, optionNotificationsStatut: maj.optionNotificationsStatut, optionFacturationIzyfacture: maj.optionFacturationIzyfacture, optionCaissePos: maj.optionCaissePos });
});

// -- Second volet d'un marchand HYBRIDE (Etape 48) : accorde, change ou retire le module secondaire.
// Reserve au super-administrateur, exactement comme les options payantes : un marchand (ou un employe) ne
// peut JAMAIS se l'accorder, et cette action est masquee de son journal (voir ACTIONS_SUPERADMIN_SEULEMENT).
// Retirer le module le MASQUE seulement (clients, menu, onglets, rappels) : ses donnees restent intactes
// et reapparaissent telles quelles si le module est accorde a nouveau. --
app.put("/api/marchands/:id/module-secondaire", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = engines[req.params.id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + req.params.id });
  const corps = req.body || {};
  const brut = corps.modulesSecondaires !== undefined ? corps.modulesSecondaires : corps.moduleSecondaire;
  const lecture = lireDemandeSecondaires(brut, entry.merchant.type);
  if (lecture.erreur) return res.status(400).json({ erreur: lecture.erreur });
  const demande = lecture.liste;
  const avant = modulesDuMarchand(entry.merchant).slice(1);
  try {
    if (demande.join(",") !== avant.join(",")) {
      const maj = await db.updateMerchantFields(req.params.id, { moduleSecondaire: demande.join(",") || null });
      if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
      await appliquerModuleSecondaire(entry, demande);
    }
  } catch (erreur) {
    console.error(`[${req.params.id}] Echec du changement de module secondaire :`, erreur);
    return res.status(500).json({ erreur: "Impossible de modifier le second volet." });
  }
  res.locals.audit = { detail: { avant: avant.join(",") || null, apres: demande.join(",") || null } };
  console.log(`[${req.params.id}] Volets secondaires modifiés par ${req.auth.adminUser} : ${avant.join("+") || "aucun"} -> ${demande.join("+") || "aucun"}.`);
  res.json({ id: req.params.id, moduleSecondaire: demande[0] || null, modulesSecondaires: demande, modules: modulesDuMarchand(entry.merchant) });
});

// ---------------- Facturation INTEGREE (Etapes 54-56) ----------------
// Un marchand a UNE seule source de facturation a la fois, choisie par le SUPER-ADMINISTRATEUR seul :
//   "aucune"     : pas de facturation (comportement d'origine)
//   "interne"    : mini-module de facturation integre a IzyVendeur (facturation.js)
//   "izyfacture" : pont vers l'application IzyFacture (champ existant optionFacturationIzyfacture)
// Ni le marchand, ni ses employes, ne peuvent changer cette source ni voir les commandes qui la changent :
// routes reservees a req.auth.role === "superadmin" (403 sinon) et actions masquees du journal du marchand
// (ACTIONS_SUPERADMIN_SEULEMENT). Le passage "interne" -> "izyfacture" est a SENS UNIQUE : il passe par la
// bascule (apercu + confirmation) et on ne revient jamais a "interne" ensuite.
//
// La source "interne" est portee par le moteur de facturation (config.interne) ; "izyfacture" par
// merchant.optionFacturationIzyfacture ; les deux ne sont jamais vraies en meme temps (voir definirSource).

function sourceFacturation(entry) {
  if (entry.facturation && entry.facturation.config().interne) return "interne";
  return entry.merchant.optionFacturationIzyfacture === true ? "izyfacture" : "aucune";
}
// L'onglet Facturation (et la lecture des pieces) reste disponible tant qu'il existe des donnees integrees,
// meme apres la bascule : l'historique ne disparait jamais.
function facturationInterneVisible(entry) {
  return !!entry.facturation && (entry.facturation.config().interne || entry.facturation.aDesDonnees());
}
// Source qui a facture (ou facturera) CET objet : une commande deja facturee garde la source de sa facture.
function sourceDeLObjet(entry, order) {
  return order && order.izyfactureFactureId ? (order.factureSource || "izyfacture") : sourceFacturation(entry);
}
function facturationAutoActive(entry) {
  return sourceFacturation(entry) === "interne" ? entry.facturation.config().autoFacturation === true : entry.merchant.izyfactureAutoFacturation === true;
}
// true si la facturation peut s'executer pour cet objet (utilise par les declenchements automatiques).
function facturationPeutAgir(entry, order) {
  const src = sourceDeLObjet(entry, order);
  if (src === "interne") return !!entry.facturation;
  return src === "izyfacture" && entry.merchant.optionFacturationIzyfacture === true && !!entry.merchant.izyfactureApiKey;
}
// Controle commun des routes manuelles "facturer"/"paiement" d'une commande ou d'un rendez-vous.
// Renvoie null si tout est en ordre, sinon { status, erreur }.
function refusFacturationManuelle(entry, order, action) {
  if (action === "paiement" && order && order.factureSource === "interne" && entry.facturation) return null;
  const src = sourceFacturation(entry);
  if (src === "interne") return null;
  if (src !== "izyfacture") return { status: 403, erreur: "Cette option n'est pas activée pour ce marchand." };
  if (!entry.merchant.izyfactureApiKey) return { status: 400, erreur: "Aucune clé IzyFacture enregistrée pour ce marchand." };
  return null;
}

function urlPubliqueFacture(token) {
  const base = process.env.DOMAINE_PUBLIC ? "https://" + process.env.DOMAINE_PUBLIC : (process.env.BASE_URL_PUBLIQUE || "https://izyvendeur.app");
  return base.replace(/\/+$/, "") + "/f/" + token;
}

// Etape 59 : controle du droit d'accorder une remise (proprietaire / super-administrateur : sans plafond ;
// employe : role « remises » + plafond en % qui lui est propre).
function controleRemise(req, pourcentEffectif) {
  return remisesLib.verifierDroit(req.auth, estGestionnaireDuMarchand(req, req.params.id), pourcentEffectif);
}

function lignesFactureInterne(entry, order) {
  if (estRendezVous(entry)) return [{ designation: order.service || "Prestation", quantite: 1, prixUnitaire: Number(order.prix) || 0 }];
  return (order.items || []).map((it) => {
    let d = it.produit || "Article";
    const variante = [it.couleur, it.taille].filter((x) => x && x !== "-" && x !== "—" && x !== "–").join(" ");
    if (variante) d += " (" + variante + ")";
    const l = { designation: d, quantite: it.quantite || 1, prixUnitaire: it.prixUnitaire || 0 };
    if (it.remiseLigne > 0) l.remise = { type: "montant", valeur: it.remiseLigne };
    return l;
  });
}

async function tenterFacturationInterne(entry, order, options) {
  const rdv = estRendezVous(entry);
  if (order.izyfactureFactureId && order.factureSource === "interne") return; // deja facturee
  if (rdv && !(Number(order.prix) > 0)) {
    entry.engine.enregistrerEtatIzyFacture(order.id, { izyfactureStatut: "erreur", izyfactureErreur: "Prix du rendez-vous nul : rien à facturer." });
    return;
  }
  const ref = rdv ? izyfacture.externalRefPourRendezVous(entry.merchant.id, order.id) : izyfacture.externalRefPourCommande(entry.merchant.id, order.id);
  const pos = !rdv && order.source === "pos";
  const cl = (pos && options && options.client) || {};
  const nom = (cl.nom && String(cl.nom).trim()) || (rdv && order.clientNom ? order.clientNom : (order.telephone ? "Client WhatsApp " + order.telephone : (pos ? "Client comptoir" : "Client IzyVendeur")));
  const r = entry.facturation.creerFacture({
    client: { nom, telephone: cl.telephone || order.telephone || null, niu: cl.niu || null, adresse: cl.adresse || null },
    lignes: lignesFactureInterne(entry, order),
    remiseGlobale: order.remise && order.remise.globale ? { type: "montant", valeur: order.remise.globale.montant } : null,
    motifRemise: order.remise ? order.remise.motif : null,
    remiseAccordePar: order.remise ? order.remise.accordePar : null,
    notes: (rdv ? "Rendez-vous WhatsApp " : (pos ? "Vente en boutique " : "Commande WhatsApp ")) + ref,
    origine: { type: rdv ? "rdv" : "commande", id: order.id },
    externalRef: ref,
    creePar: "automatique"
  });
  if (r.erreur) {
    entry.engine.enregistrerEtatIzyFacture(order.id, { izyfactureStatut: "erreur", izyfactureErreur: r.erreur });
    console.error(`[${entry.merchant.id}] Échec de facturation intégrée (${libelleObjetFacture(entry, order)}) : ${r.erreur}`);
    return;
  }
  let f = r.facture;
  // Vente de la Caisse POS : deja encaissee au comptoir, donc la facture est reglee d'emblee (meme mode de
  // paiement), et la vente au comptant du journal est annulee au profit de la facture (jamais comptee 2 fois).
  if (pos && !r.duplicate) {
    const MODE = { especes: "especes", om: "om", momo: "momo", carte: "banque", cheque: "cheque" };
    const pay = entry.facturation.enregistrerPaiement(f.id, { montant: f.total, methode: MODE[order.modePaiement] || "especes", reference: order.referencePaiement || ("POS-" + String(order.id).padStart(4, "0")), creePar: "caisse" });
    if (!pay.erreur) f = pay.facture;
    entry.facturation.noterEvenementPos(order.id, "remplacee");
  }
  entry.engine.enregistrerEtatIzyFacture(order.id, {
    factureSource: "interne",
    izyfactureStatut: "facturee",
    izyfactureFactureId: f.id,
    izyfactureNumero: f.numero,
    izyfactureUrlVerification: urlPubliqueFacture(f.token),
    izyfactureErreur: null
  });
  console.log(`[${entry.merchant.id}] Facture intégrée ${f.numero} créée pour ${libelleObjetFacture(entry, order)}${r.duplicate ? " (déjà existante, aucun doublon)" : ""}.`);
  if (!r.duplicate) {
    try {
      await notifierClientFactureCreee(entry, order, { number: f.numero, totals: { ttc: f.total }, verifyUrl: urlPubliqueFacture(f.token) });
    } catch (e) {
      console.error(`[${entry.merchant.id}] Échec de la notification client (facture intégrée) :`, e.message || e);
    }
  }
}

// Avoir integre : total (ce qui reste a creditier) pour une commande/un rendez-vous annule.
function tenterAvoirInterne(entry, order, raison) {
  if (!order.izyfactureFactureId) return;
  const r = entry.facturation.creerAvoir(order.izyfactureFactureId, { motif: raison || (estRendezVous(entry) ? "Rendez-vous annulé" : "Commande annulée"), creePar: "automatique" });
  if (r.erreur && !/déjà entièrement/.test(r.erreur)) {
    console.error(`[${entry.merchant.id}] Échec d'avoir intégré (${libelleObjetFacture(entry, order)}) : ${r.erreur}`);
    return;
  }
  const f = r.facture || entry.facturation.factureParId(order.izyfactureFactureId);
  const dernierAvoir = f.avoirs[f.avoirs.length - 1];
  entry.engine.enregistrerEtatIzyFacture(order.id, {
    izyfactureStatut: "avoir",
    izyfactureAvoirNumero: dernierAvoir ? dernierAvoir.numero : null,
    izyfactureSolde: f.solde,
    izyfactureErreur: null
  });
  console.log(`[${entry.merchant.id}] Avoir intégré ${dernierAvoir ? dernierAvoir.numero : ""} pour ${libelleObjetFacture(entry, order)}.`);
}

async function enregistrerPaiementInterne(entry, order, { montant, methode, reference }, creePar) {
  const r = entry.facturation.enregistrerPaiement(order.izyfactureFactureId, { montant, methode, reference, creePar });
  if (r.erreur) {
    const erreur = new Error(r.erreur);
    erreur.status = r.statut || 400;
    throw erreur;
  }
  const historique = (order.izyfacturePaiements || []).concat([{ montant, methode, reference: reference || null, date: new Date().toISOString(), recuNumero: r.paiement.recuNumero }]);
  entry.engine.enregistrerEtatIzyFacture(order.id, {
    izyfactureFactureStatut: r.facture.statut === "paid" ? "paid" : "partially_paid",
    izyfactureSolde: r.facture.solde,
    izyfactureRecuNumero: r.paiement.recuNumero,
    izyfacturePaiements: historique
  });
  console.log(`[${entry.merchant.id}] Paiement de ${montant} FCFA enregistré sur la facture intégrée ${r.facture.numero}, reçu ${r.paiement.recuNumero}.`);
  try {
    await notifierClientPaiementRecu(entry, order, montant, r.paiement.recuNumero);
  } catch (e) {
    console.error(`[${entry.merchant.id}] Échec de la notification client (paiement intégré) :`, e.message || e);
  }
}

// Apres un paiement/avoir saisi depuis l'onglet Facturation : reflete l'etat sur la commande/le rendez-vous
// d'origine, pour que la colonne "Facture" de Commandes/Rendez-vous reste a jour.
function refleterSurObjetOrigine(entry, facture) {
  const o = facture.origine || {};
  const moteur = o.type === "commande" ? entry.moteurs.catalogue : o.type === "rdv" ? entry.moteurs.service : null;
  if (!moteur || o.id == null) return;
  const patch = { izyfactureSolde: facture.solde };
  if (facture.statut === "paid" || facture.statut === "partially_paid") patch.izyfactureFactureStatut = facture.statut;
  if (facture.paiements.length) {
    const dernier = facture.paiements[facture.paiements.length - 1];
    patch.izyfactureRecuNumero = dernier.recuNumero;
    patch.izyfacturePaiements = facture.paiements.map((p) => ({ montant: p.montant, methode: p.methode, reference: p.reference, date: p.date, recuNumero: p.recuNumero }));
  }
  if (facture.statut === "avoir") {
    patch.izyfactureStatut = "avoir";
    patch.izyfactureAvoirNumero = facture.avoirs[facture.avoirs.length - 1].numero;
  }
  moteur.enregistrerEtatIzyFacture(o.id, patch);
}

function vueFactureAPI(f) {
  return Object.assign({}, f, { url: urlPubliqueFacture(f.token), nbPaiements: f.paiements.length });
}

// -- Controle d'acces des routes /api/:id/facturation/* : lecture = "facturation" OU "comptable" (le
// comptable ne peut JAMAIS ecrire), ecriture = "facturation". Proprietaire et super-administrateur : tout.
function entreeFacturation(req, res, ecriture) {
  const entry = getMarchandAutorise(req, res, ecriture ? ["facturation"] : ["facturation", "comptable"]);
  if (!entry) return null;
  if (!facturationInterneVisible(entry)) { res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." }); return null; }
  return entry;
}
function nomActeur(req) { return req.auth.adminUser || "inconnu"; }

app.get("/api/:id/facturation", protegerAcces, (req, res) => {
  const entry = entreeFacturation(req, res, false); if (!entry) return;
  const fa = entry.facturation;
  const factures = fa.listeFactures().map(vueFactureAPI);
  const depenses = fa.listeDepenses();
  const c = fa.config();
  res.json({
    source: sourceFacturation(entry),
    interneActif: c.interne === true,
    autoFacturation: c.autoFacturation === true,
    dateBascule: c.dateBascule || null,
    factures, depenses,
    tva: { actif: !!(c.tva && c.tva.actif), taux: c.tva ? c.tva.taux : 19.25 },
    identite: c.identite || { niu: "", rccm: "", adresse: "", telephone: "" },
    totaux: {
      factureNet: factures.reduce((s, f) => s + f.net, 0),
      encaisse: factures.reduce((s, f) => s + (f.paye - f.rembourse), 0),
      soldeOuvert: factures.reduce((s, f) => s + f.solde, 0),
      aRembourser: factures.reduce((s, f) => s + f.aRembourser, 0),
      depenses: depenses.filter((d) => !d.annulee).reduce((s, d) => s + d.montant, 0),
      tvaCollectee: factures.reduce((s, f) => s + (f.tvaNette || 0), 0),
      tvaDeductible: depenses.filter((d) => !d.annulee).reduce((s, d) => s + (d.tvaDeductible || 0), 0)
    },
    methodes: METHODES_PAIEMENT, categories: CATEGORIES_DEPENSE
  });
});

// Etape 59 : articles proposables dans la facture libre (catalogue et/ou services du marchand). Reserve au role
// « facturation » : un employe de facturation n'a pas besoin du role « catalogue » pour piocher dans la liste.
app.get("/api/:id/facturation/articles", protegerAcces, (req, res) => {
  const entry = entreeFacturation(req, res, true); if (!entry) return;
  const moteurs = entry.moteurs || {};
  const cat = moteurs.catalogue || (entry.engine && entry.engine.type === "catalogue" ? entry.engine : null);
  const svc = moteurs.service || (entry.engine && entry.engine.type === "service" ? entry.engine : null);
  const articles = [];
  if (cat) {
    for (const p of cat.getCatalog() || []) {
      for (const v of p.variantes || []) {
        const decl = [v.couleur, v.taille].filter((x) => x && String(x).trim()).join(" ");
        articles.push({ type: "produit", libelle: p.nom + (decl ? " (" + decl + ")" : ""), prix: Number(v.prix) || 0 });
      }
    }
  }
  if (svc) {
    for (const s of svc.getServices() || []) articles.push({ type: "service", libelle: s.nom, prix: Number(s.prix) || 0 });
  }
  res.json(articles.filter((a) => a.prix >= 0));
});

app.post("/api/:id/facturation/factures", protegerAcces, (req, res) => {
  const entry = entreeFacturation(req, res, true); if (!entry) return;
  if (sourceFacturation(entry) !== "interne") return res.status(403).json({ erreur: "La facturation intégrée n'est plus active pour ce marchand." });
  const b = req.body || {};
  // Etape 59 : remises (par ligne et/ou globale) soumises au droit « remises » et au plafond de l'employe.
  const aRemise = (b.remiseGlobale && Number(b.remiseGlobale.valeur) > 0) || (Array.isArray(b.lignes) && b.lignes.some((l) => l && l.remise && Number(l.remise.valeur) > 0));
  if (aRemise) {
    const lignesBrutes = Array.isArray(b.lignes) ? b.lignes.map((l) => ({ brut: (Number(l && l.quantite) || 0) * (Number(l && l.prixUnitaire) || 0), remise: l && l.remise })) : [];
    const c = remisesLib.appliquer(lignesBrutes, b.remiseGlobale);
    if (c.erreur) return res.status(400).json({ erreur: c.erreur });
    const refus = controleRemise(req, c.pourcentEffectif);
    if (refus) return res.status(refus.statut).json({ erreur: refus.erreur });
  }
  const r = entry.facturation.creerFacture({ client: b.client, lignes: b.lignes, notes: b.notes, remiseGlobale: b.remiseGlobale, motifRemise: b.motifRemise, remiseAccordePar: nomActeur(req), origine: { type: "libre", id: null }, creePar: nomActeur(req) });
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  res.locals.audit = { detail: Object.assign({ facture: r.facture.numero, total: r.facture.total }, r.facture.remiseTotale > 0 ? { remise: r.facture.remiseTotale, motif: r.facture.motifRemise } : {}) };
  res.status(201).json(vueFactureAPI(r.facture));
});

app.post("/api/:id/facturation/factures/:fid/paiement", protegerAcces, async (req, res) => {
  const entry = entreeFacturation(req, res, true); if (!entry) return;
  const b = req.body || {};
  const r = entry.facturation.enregistrerPaiement(req.params.fid, { montant: b.montant, methode: b.methode, reference: b.reference, creePar: nomActeur(req) });
  if (r.erreur) return res.status(r.statut || 400).json({ erreur: r.erreur });
  refleterSurObjetOrigine(entry, r.facture);
  res.json({ facture: vueFactureAPI(r.facture), recu: r.paiement.recuNumero });
  const o = r.facture.origine;
  const obj = o.type === "commande" && entry.moteurs.catalogue ? entry.moteurs.catalogue.getOrderById(o.id)
    : o.type === "rdv" && entry.moteurs.service ? entry.moteurs.service.getAppointmentById(o.id) : null;
  if (obj) {
    const vueObj = vueEntree(entry, o.type === "rdv" ? "service" : "catalogue");
    notifierClientPaiementRecu(vueObj, obj, r.paiement.montant, r.paiement.recuNumero).catch((e) => console.error(`[${req.params.id}] Notification paiement :`, e.message || e));
  }
});

app.post("/api/:id/facturation/factures/:fid/avoir", protegerAcces, (req, res) => {
  const entry = entreeFacturation(req, res, true); if (!entry) return;
  const b = req.body || {};
  const r = entry.facturation.creerAvoir(req.params.fid, { montant: b.montant, motif: b.motif, creePar: nomActeur(req) });
  if (r.erreur) return res.status(r.statut || 400).json({ erreur: r.erreur });
  refleterSurObjetOrigine(entry, r.facture);
  res.json({ facture: vueFactureAPI(r.facture), avoir: r.avoir.numero });
});

app.post("/api/:id/facturation/factures/:fid/remboursement", protegerAcces, (req, res) => {
  const entry = entreeFacturation(req, res, true); if (!entry) return;
  const b = req.body || {};
  const r = entry.facturation.enregistrerRemboursement(req.params.fid, { montant: b.montant, methode: b.methode, reference: b.reference, creePar: nomActeur(req) });
  if (r.erreur) return res.status(r.statut || 400).json({ erreur: r.erreur });
  refleterSurObjetOrigine(entry, r.facture);
  res.json({ facture: vueFactureAPI(r.facture), remboursement: r.remboursement.numero });
});

app.post("/api/:id/facturation/depenses", protegerAcces, (req, res) => {
  const entry = entreeFacturation(req, res, true); if (!entry) return;
  if (sourceFacturation(entry) !== "interne") return res.status(403).json({ erreur: "La facturation intégrée n'est plus active pour ce marchand." });
  const b = req.body || {};
  const r = entry.facturation.creerDepense({ date: b.date, categorie: b.categorie, montant: b.montant, tvaDeductible: b.tvaDeductible, methode: b.methode, fournisseur: b.fournisseur, note: b.note, justificatif: b.justificatif, creePar: nomActeur(req) });
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  res.status(201).json(r.depense);
});

app.post("/api/:id/facturation/depenses/:did/annuler", protegerAcces, (req, res) => {
  const entry = entreeFacturation(req, res, true); if (!entry) return;
  if (sourceFacturation(entry) !== "interne") return res.status(403).json({ erreur: "La facturation intégrée n'est plus active pour ce marchand." });
  const r = entry.facturation.annulerDepense(req.params.did, { motif: (req.body || {}).motif });
  if (r.erreur) return res.status(r.statut || 400).json({ erreur: r.erreur });
  res.json(r.depense);
});

// Journal normalise : lu par IzyCompta (ou telecharge par le comptable). JSON par defaut, CSV avec ?format=csv.
// Filtres facultatifs ?du=AAAA-MM-JJ&au=AAAA-MM-JJ&apres=<instant ISO> (import incremental). Chaque ligne a un
// `id` unique et stable (anti-doublon). Etape 57 : y figurent aussi les ventes de la Caisse POS (au comptant).
function ventesPosDuMarchand(entry) {
  const cat = entry.moteurs && entry.moteurs.catalogue;
  return cat ? cat.getOrders().filter((o) => o.source === "pos") : [];
}
function filtreJournalDepuisRequete(req) {
  const motif = /^\d{4}-\d{2}-\d{2}$/;
  const du = motif.test(String(req.query.du || "")) ? String(req.query.du) : null;
  const au = motif.test(String(req.query.au || "")) ? String(req.query.au) : null;
  const apresBrut = String(req.query.apres || "");
  const apres = apresBrut && !isNaN(new Date(apresBrut).getTime()) ? new Date(apresBrut).toISOString() : null;
  return { du, au, apres };
}
function repondreJournalFacturation(entry, req, res) {
  const filtre = filtreJournalDepuisRequete(req);
  const ext = { ventesPos: ventesPosDuMarchand(entry) };
  if (String(req.query.format || "").toLowerCase() === "csv") {
    const sep = String(req.query.sep || "") === ";" || String(req.query.sep || "").toLowerCase() === "semicolon" ? ";" : ",";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="journal-${req.params.id}.csv"`);
    return res.send(entry.facturation.journalCsv(filtre, sep, ext));
  }
  const c = entry.facturation.config();
  const ecritures = entry.facturation.journal(filtre, ext);
  res.json({ marchand: req.params.id, source: "izyvendeur-interne", devise: "XAF", dateBascule: c.dateBascule || null, basculeLe: c.basculeLe || null, tva: c.tva ? { actif: !!c.tva.actif, taux: c.tva.taux } : null, nbEcritures: ecritures.length, ecritures });
}
app.get("/api/:id/facturation/journal", protegerAcces, (req, res) => {
  const entry = entreeFacturation(req, res, false); if (!entry) return;
  repondreJournalFacturation(entry, req, res);
});

// ---- Acces d'IzyCompta par CLE COMPTABLE (Etape 57) : lecture seule du journal, sans connexion /admin ----
// Cle generee/revoquee par le SUPER-ADMINISTRATEUR seul (routes plus bas). Jeton porte dans l'en-tete
// Authorization: Bearer izc_... (jamais dans l'URL), stocke uniquement sous forme d'empreinte SHA-256. Les
// reponses ne donnent aucun indice sur la raison d'un refus (cle fausse, revoquee, marchand inconnu ou
// suspendu : toujours le meme 401), et les echecs repetes depuis une meme adresse sont ralentis (429).
const echecsCleComptable = new Map(); // ip -> { n, debut }
const FENETRE_ECHECS_MS = 10 * 60 * 1000, MAX_ECHECS = 20;
function trop_d_echecs(ip) {
  const e = echecsCleComptable.get(ip);
  if (!e) return false;
  if (Date.now() - e.debut > FENETRE_ECHECS_MS) { echecsCleComptable.delete(ip); return false; }
  return e.n >= MAX_ECHECS;
}
function noterEchecCle(ip) {
  const e = echecsCleComptable.get(ip);
  if (!e || Date.now() - e.debut > FENETRE_ECHECS_MS) echecsCleComptable.set(ip, { n: 1, debut: Date.now() });
  else e.n++;
}
function enTetesCorsCompta(res) {
  // Pas de cookies ici (jeton en en-tete) : l'ouverture a toute origine ne donne rien a un site tiers sans la cle.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Cache-Control", "no-store");
}
app.options("/api/compta/:id/journal", (req, res) => { enTetesCorsCompta(res); res.status(204).end(); });
app.get("/api/compta/:id/journal", (req, res) => {
  enTetesCorsCompta(res);
  const ip = req.ip || "inconnue";
  if (trop_d_echecs(ip)) return res.status(429).json({ erreur: "Trop de tentatives. Réessayez plus tard." });
  const entete = String(req.headers.authorization || "");
  const jeton = /^Bearer\s+(\S+)$/i.test(entete) ? entete.replace(/^Bearer\s+/i, "") : "";
  const entry = engines[req.params.id];
  const ok = !!(entry && entry.facturation && entry.merchant.actif !== false && facturationInterneVisible(entry) && entry.facturation.verifierCleComptable(jeton));
  if (!ok) { noterEchecCle(ip); return res.status(401).json({ erreur: "Clé comptable invalide ou révoquée." }); }
  repondreJournalFacturation(entry, req, res);
});

// Gestion de la cle : SUPER-ADMINISTRATEUR UNIQUEMENT (le marchand ne peut ni la voir, ni la creer, ni la revoquer).
app.get("/api/:id/facturation/cle-comptable", protegerAcces, (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  res.json(entry.facturation.etatCleComptable());
});
app.post("/api/:id/facturation/cle-comptable", protegerAcces, (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  if (!facturationInterneVisible(entry)) return res.status(409).json({ erreur: "Ce marchand n'a pas de facturation intégrée : il n'y a pas de journal à lire." });
  const jeton = entry.facturation.genererCleComptable(req.auth.adminUser);
  res.locals.audit = { detail: { indice: jeton.slice(-4) } };
  console.log(`[${req.params.id}] Clé comptable générée par ${req.auth.adminUser} (fin ${jeton.slice(-4)}).`);
  res.status(201).json({ cle: jeton, etat: entry.facturation.etatCleComptable(), url: "/api/compta/" + req.params.id + "/journal" });
});
app.delete("/api/:id/facturation/cle-comptable", protegerAcces, (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  entry.facturation.revoquerCleComptable();
  console.log(`[${req.params.id}] Clé comptable révoquée par ${req.auth.adminUser}.`);
  res.json(entry.facturation.etatCleComptable());
});

// Reglage reserve au proprietaire/super-administrateur : facturation automatique (integree).
app.put("/api/:id/facturation/parametres", protegerAcces, (req, res) => {
  const entry = getMarchandOu404(req, res); if (!entry) return;
  if (!estGestionnaireDuMarchand(req, req.params.id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  if (sourceFacturation(entry) !== "interne") return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const b = req.body || {};
  if (b.autoFacturation === undefined && !b.tva && !b.identite) return res.status(400).json({ erreur: "Rien à modifier." });
  const r = entry.facturation.definirParametres({ autoFacturation: b.autoFacturation, tva: b.tva, identite: b.identite });
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  const c = r.config;
  res.json({ autoFacturation: c.autoFacturation === true, tva: { actif: !!c.tva.actif, taux: c.tva.taux }, identite: c.identite });
});

// ---- Choix de la source : SUPER-ADMINISTRATEUR UNIQUEMENT ----
app.put("/api/:id/facturation/source", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  const cible = String((req.body || {}).source || "");
  if (["aucune", "interne", "izyfacture"].indexOf(cible) === -1) return res.status(400).json({ erreur: "source doit être 'aucune', 'interne' ou 'izyfacture'." });
  const actuelle = sourceFacturation(entry);
  const cfg = entry.facturation.config();
  if (cible === actuelle) return res.json({ source: actuelle });
  if (cible === "interne" && cfg.dateBascule) return res.status(409).json({ erreur: "Ce marchand a déjà basculé vers IzyFacture : le retour à la facturation intégrée est impossible (sens unique)." });
  if (cible === "izyfacture" && actuelle === "interne") return res.status(409).json({ erreur: "Pour passer de la facturation intégrée à IzyFacture, utilisez la bascule (aperçu puis confirmation)." });
  try {
    if (cible === "interne") {
      await db.updateMerchantFields(req.params.id, { optionFacturationIzyfacture: false });
      entry.merchant.optionFacturationIzyfacture = false;
      entry.facturation.modifierConfig({ interne: true, dateActivation: cfg.dateActivation || new Date().toISOString() });
    } else if (cible === "izyfacture") {
      await db.updateMerchantFields(req.params.id, { optionFacturationIzyfacture: true });
      entry.merchant.optionFacturationIzyfacture = true;
    } else { // aucune
      if (actuelle === "interne") entry.facturation.modifierConfig({ interne: false });
      if (entry.merchant.optionFacturationIzyfacture) {
        await db.updateMerchantFields(req.params.id, { optionFacturationIzyfacture: false });
        entry.merchant.optionFacturationIzyfacture = false;
      }
    }
  } catch (erreur) {
    console.error(`[${req.params.id}] Échec du changement de source de facturation :`, erreur);
    return res.status(500).json({ erreur: "Impossible de modifier la source de facturation." });
  }
  res.locals.audit = { detail: { avant: actuelle, apres: cible } };
  console.log(`[${req.params.id}] Source de facturation modifiée par ${req.auth.adminUser} : ${actuelle} -> ${cible}.`);
  res.json({ source: sourceFacturation(entry) });
});

app.get("/api/:id/facturation/bascule/apercu", protegerAcces, (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  if (sourceFacturation(entry) !== "interne") return res.status(400).json({ erreur: "La bascule n'est possible que depuis la facturation intégrée." });
  res.json(Object.assign({
    cleIzyfactureEnregistree: !!entry.merchant.izyfactureApiKey,
    autoFacturation: entry.facturation.config().autoFacturation === true
  }, entry.facturation.apercuBascule()));
});

app.post("/api/:id/facturation/bascule", protegerAcces, async (req, res) => {
  if (req.auth.role !== "superadmin") return res.status(403).json({ erreur: "Réservé au super-administrateur." });
  const entry = getMarchandOu404(req, res); if (!entry) return;
  if (sourceFacturation(entry) !== "interne") return res.status(400).json({ erreur: "La bascule n'est possible que depuis la facturation intégrée." });
  if ((req.body || {}).confirmer !== true) return res.status(400).json({ erreur: "Confirmation requise : envoyez confirmer=true après avoir consulté l'aperçu. Cette opération est à sens unique." });
  if (!entry.merchant.izyfactureApiKey) return res.status(400).json({ erreur: "Enregistrez d'abord la clé IzyFacture du marchand (Paramètres) avant de basculer." });
  const cle = cryptoUtil.dechiffrer(entry.merchant.izyfactureApiKey);
  if (!cle) return res.status(400).json({ erreur: "Clé IzyFacture illisible — réenregistrez-la avant de basculer." });
  try {
    await izyfacture.verifierCle(cle); // on ne bascule jamais vers une cle qui ne fonctionne pas
  } catch (erreur) {
    return res.status(statutReponseExterne(erreur)).json({ erreur: "Clé IzyFacture refusée : " + (erreur.message || "connexion impossible") + ". Bascule annulée." });
  }
  const apercu = entry.facturation.apercuBascule();
  const auto = entry.facturation.config().autoFacturation === true;
  const maintenant = new Date().toISOString();
  try {
    const patch = { optionFacturationIzyfacture: true };
    if (auto) patch.izyfactureAutoFacturation = true; // la facturation automatique est conservee
    const maj = await db.updateMerchantFields(req.params.id, patch);
    if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
    entry.merchant.optionFacturationIzyfacture = true;
    if (auto) entry.merchant.izyfactureAutoFacturation = true;
    entry.facturation.modifierConfig({ interne: false, dateBascule: entry.facturation.dateLocale(maintenant), basculeLe: maintenant, basculePar: req.auth.adminUser });
  } catch (erreur) {
    console.error(`[${req.params.id}] Échec de la bascule :`, erreur);
    return res.status(500).json({ erreur: "Impossible d'effectuer la bascule." });
  }
  res.locals.audit = { detail: { dateBascule: entry.facturation.config().dateBascule, facturesOuvertes: apercu.facturesOuvertes.length } };
  console.log(`[${req.params.id}] BASCULE facturation intégrée -> IzyFacture par ${req.auth.adminUser} (${apercu.nbFactures} facture(s), ${apercu.facturesOuvertes.length} avec solde ouvert).`);
  res.json({ source: sourceFacturation(entry), dateBascule: entry.facturation.config().dateBascule, apercu });
});

// ---- Pages publiques imprimables (facture, recu) : acces par jeton aleatoire de 128 bits, sans connexion ----
function echapperHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const MOTS_PAGE = {
  fr: { facture: "Facture", recu: "Reçu", avoir: "Avoir", date: "Date", client: "Client", designation: "Désignation", qte: "Qté", pu: "Prix unitaire", total: "Total", paye: "Payé", solde: "Solde à payer", ht: "Total HT", tva: "TVA", remise: "Remise", sousTotal: "Sous-total", remiseGlobale: "Remise globale", niu: "NIU", remboursements: "Remboursements", paiements: "Paiements", avoirs: "Avoirs", imprimer: "Imprimer / Enregistrer en PDF", ttc: "Montants en FCFA, toutes taxes comprises.", methode: { especes: "Espèces", om: "Orange Money", momo: "MTN MoMo", banque: "Virement", cheque: "Chèque", autre: "Autre" }, statut: { issued: "Émise", partially_paid: "Partiellement payée", paid: "Payée", avoir: "Annulée (avoir)" }, recuPour: "Reçu pour la facture", montantRecu: "Montant reçu", mode: "Mode de paiement", reference: "Référence", merci: "Merci pour votre confiance." },
  en: { facture: "Invoice", recu: "Receipt", avoir: "Credit note", date: "Date", client: "Customer", designation: "Description", qte: "Qty", pu: "Unit price", total: "Total", paye: "Paid", solde: "Balance due", ht: "Total excl. tax", tva: "VAT", remise: "Discount", sousTotal: "Subtotal", remiseGlobale: "Overall discount", niu: "Tax ID", remboursements: "Refunds", paiements: "Payments", avoirs: "Credit notes", imprimer: "Print / Save as PDF", ttc: "Amounts in FCFA, taxes included.", methode: { especes: "Cash", om: "Orange Money", momo: "MTN MoMo", banque: "Bank transfer", cheque: "Cheque", autre: "Other" }, statut: { issued: "Issued", partially_paid: "Partially paid", paid: "Paid", avoir: "Cancelled (credit note)" }, recuPour: "Receipt for invoice", montantRecu: "Amount received", mode: "Payment method", reference: "Reference", merci: "Thank you for your business." }
};
function fcfa(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " FCFA"; }
function dateAffichee(iso, lang) { return new Date(iso).toLocaleDateString(lang === "en" ? "en-GB" : "fr-FR", { timeZone: "Africa/Douala" }); }

function enTetePage(titre, entry) {
  const m = entry.merchant;
  const idt = (entry.facturation && entry.facturation.config().identite) || {};
  const ligneIdentite = [idt.adresse, idt.telephone, idt.niu ? "NIU : " + idt.niu : "", idt.rccm ? "RCCM : " + idt.rccm : ""].filter(Boolean).map(echapperHtml).join(" — ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${echapperHtml(titre)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;color:#222;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:1.5em;margin:0}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:2px solid #222;padding-bottom:10px;margin-bottom:14px}.top img{max-height:64px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}td.n,th.n{text-align:right;white-space:nowrap}.tot{font-weight:bold}.badge{display:inline-block;padding:2px 10px;border-radius:10px;background:#eee;font-size:.85em}.note{color:#666;font-size:.85em;margin-top:18px}button{padding:8px 14px;margin-top:10px;cursor:pointer}@media print{button{display:none}body{margin:0}}</style></head><body>
<div class="top"><div><strong style="font-size:1.2em">${echapperHtml(m.nom)}</strong>${ligneIdentite ? `<div style="font-size:.85em;color:#555">${ligneIdentite}</div>` : ""}</div>${m.logoUrl ? `<img src="${echapperHtml(m.logoUrl)}" alt="">` : ""}</div>`;
}

function pageFacture(entry, f, lang) {
  const w = MOTS_PAGE[lang];
  let h = enTetePage(w.facture + " " + f.numero, entry);
  h += `<h1>${w.facture} ${echapperHtml(f.numero)}</h1><p>${w.date} : ${echapperHtml(dateAffichee(f.creeLe, lang))} &nbsp; <span class="badge">${echapperHtml(w.statut[f.statut] || f.statut)}</span></p>`;
  h += `<p><strong>${w.client} :</strong> ${echapperHtml(f.client.nom)}${f.client.telephone ? " — " + echapperHtml(f.client.telephone) : ""}${f.client.niu ? " — " + w.niu + " : " + echapperHtml(f.client.niu) : ""}${f.client.adresse ? "<br>" + echapperHtml(f.client.adresse) : ""}</p>`;
  h += `<table><tr><th>${w.designation}</th><th class="n">${w.qte}</th><th class="n">${w.pu}</th><th class="n">${w.total}</th></tr>`;
  f.lignes.forEach((l) => {
    const rl = l.remiseLigne > 0 ? `<div style="font-size:.8em;color:#555">${w.remise} : - ${fcfa(l.remiseLigne)}${l.remiseSpec && l.remiseSpec.type === "pourcent" ? " (" + l.remiseSpec.valeur + " %)" : ""}</div>` : "";
    h += `<tr><td>${echapperHtml(l.designation)}${rl}</td><td class="n">${l.quantite}</td><td class="n">${fcfa(l.prixUnitaire)}</td><td class="n">${fcfa(l.total)}</td></tr>`;
  });
  if (f.remiseGlobale) {
    h += `<tr><td colspan="3" class="n">${w.sousTotal}</td><td class="n">${fcfa(f.sousTotal)}</td></tr><tr><td colspan="3" class="n">${w.remiseGlobale}${f.remiseGlobale.type === "pourcent" ? " " + f.remiseGlobale.valeur + " %" : ""}</td><td class="n">- ${fcfa(f.remiseGlobale.montant)}</td></tr>`;
  }
  if (f.tauxTva != null) {
    h += `<tr><td colspan="3" class="n">${w.ht}</td><td class="n">${fcfa(f.montantHT)}</td></tr><tr><td colspan="3" class="n">${w.tva} ${f.tauxTva} %</td><td class="n">${fcfa(f.montantTva)}</td></tr>`;
  }
  h += `<tr class="tot"><td colspan="3" class="n">${w.total}</td><td class="n">${fcfa(f.total)}</td></tr></table>`;
  if (f.avoirs.length) {
    h += `<h3>${w.avoirs}</h3><table>` + f.avoirs.map((a) => `<tr><td>${echapperHtml(a.numero)} — ${echapperHtml(a.motif)}</td><td>${echapperHtml(dateAffichee(a.date, lang))}</td><td class="n">- ${fcfa(a.montant)}</td></tr>`).join("") + "</table>";
  }
  if (f.paiements.length) {
    h += `<h3>${w.paiements}</h3><table>` + f.paiements.map((p) => `<tr><td>${echapperHtml(p.recuNumero)}</td><td>${echapperHtml(dateAffichee(p.date, lang))}</td><td>${echapperHtml(w.methode[p.methode] || p.methode)}</td><td class="n"><a href="/f/${echapperHtml(f.token)}/recu/${p.id}${lang === "en" ? "?lang=en" : ""}">${fcfa(p.montant)}</a></td></tr>`).join("") + "</table>";
  }
  if ((f.remboursements || []).length) {
    h += `<h3>${w.remboursements}</h3><table>` + f.remboursements.map((r) => `<tr><td>${echapperHtml(r.numero)}</td><td>${echapperHtml(dateAffichee(r.date, lang))}</td><td>${echapperHtml(w.methode[r.methode] || r.methode)}</td><td class="n">- ${fcfa(r.montant)}</td></tr>`).join("") + "</table>";
  }
  h += `<p class="tot">${w.paye} : ${fcfa(f.paye - f.rembourse)} &nbsp;|&nbsp; ${w.solde} : ${fcfa(f.solde)}</p>`;
  h += `<p class="note">${w.ttc} ${f.notes ? echapperHtml(f.notes) : ""}</p><button onclick="window.print()">${w.imprimer}</button></body></html>`;
  return h;
}

function pageRecu(entry, f, p, lang) {
  const w = MOTS_PAGE[lang];
  let h = enTetePage(w.recu + " " + p.recuNumero, entry);
  h += `<h1>${w.recu} ${echapperHtml(p.recuNumero)}</h1><p>${w.date} : ${echapperHtml(dateAffichee(p.date, lang))}</p>`;
  h += `<p><strong>${w.client} :</strong> ${echapperHtml(f.client.nom)}</p><p>${w.recuPour} ${echapperHtml(f.numero)}</p>`;
  h += `<table><tr><td>${w.montantRecu}</td><td class="n tot">${fcfa(p.montant)}</td></tr><tr><td>${w.mode}</td><td class="n">${echapperHtml(w.methode[p.methode] || p.methode)}</td></tr>${p.reference ? `<tr><td>${w.reference}</td><td class="n">${echapperHtml(p.reference)}</td></tr>` : ""}</table>`;
  h += `<p class="note">${w.merci}</p><button onclick="window.print()">${w.imprimer}</button></body></html>`;
  return h;
}

function trouverParJetonPublic(token) {
  for (const id of Object.keys(engines)) {
    const e = engines[id];
    if (!e || !e.facturation) continue;
    const f = e.facturation.factureParToken(token);
    if (f) return { entry: e, facture: f };
  }
  return null;
}
app.get("/f/:token", (req, res) => {
  const r = trouverParJetonPublic(req.params.token);
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (!r) return res.status(404).type("text/plain").send("Document introuvable.");
  res.type("html").send(pageFacture(r.entry, r.facture, req.query.lang === "en" ? "en" : "fr"));
});
app.get("/f/:token/recu/:paiementId", (req, res) => {
  const r = trouverParJetonPublic(req.params.token);
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (!r) return res.status(404).type("text/plain").send("Document introuvable.");
  const p = r.facture.paiements.find((x) => x.id === Number(req.params.paiementId));
  if (!p) return res.status(404).type("text/plain").send("Document introuvable.");
  res.type("html").send(pageRecu(r.entry, r.facture, p, req.query.lang === "en" ? "en" : "fr"));
});

// ---------------- Pont IzyFacture (facturation automatique des commandes confirmees) ----------------
// Voir izyfacture.js (client HTTP) et crypto-util.js (chiffrement de la cle). Reserve au PROPRIETAIRE du
// marchand ou au super-administrateur (estGestionnaireDuMarchand) — jamais a un employe, meme avec le role
// "parametres" : la cle IzyFacture est une information financiere sensible, pas un reglage ordinaire.

// Etat actuel (sans jamais renvoyer la cle en clair) : indique seulement si une cle est enregistree (et son
// indice de fin, pour que le marchand reconnaisse SA cle) + la bascule d'auto-facturation.
app.get("/api/:id/izyfacture/parametres", protegerAcces, (req, res) => {
  const entry = engines[req.params.id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + req.params.id });
  if (!estGestionnaireDuMarchand(req, req.params.id)) {
    return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  }
  if (!entry.merchant.optionFacturationIzyfacture) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const cleClaire = entry.merchant.izyfactureApiKey ? cryptoUtil.dechiffrer(entry.merchant.izyfactureApiKey) : null;
  res.json({
    cleEnregistree: !!entry.merchant.izyfactureApiKey,
    indiceCle: cleClaire ? cryptoUtil.indiceAffichable(cleClaire) : "",
    autoFacturation: entry.merchant.izyfactureAutoFacturation === true
  });
});

// Enregistre/efface la cle et/ou la bascule d'auto-facturation. `apiKey: ""` efface la cle ET desactive
// automatiquement l'auto-facturation (une bascule active sans cle n'aurait aucun sens et resterait
// silencieusement inoperante).
app.put("/api/:id/izyfacture/parametres", protegerAcces, async (req, res) => {
  const entry = engines[req.params.id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + req.params.id });
  if (!estGestionnaireDuMarchand(req, req.params.id)) {
    return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  }
  if (!entry.merchant.optionFacturationIzyfacture) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const { apiKey, autoFacturation } = req.body || {};
  const patch = {};
  if (apiKey !== undefined) {
    const nettoyee = String(apiKey || "").trim();
    patch.izyfactureApiKey = nettoyee ? cryptoUtil.chiffrer(nettoyee) : null;
    if (!nettoyee) patch.izyfactureAutoFacturation = false; // voir commentaire ci-dessus
  }
  if (autoFacturation !== undefined) {
    if (autoFacturation && !patch.hasOwnProperty("izyfactureAutoFacturation") && !entry.merchant.izyfactureApiKey && !(apiKey && String(apiKey).trim())) {
      return res.status(400).json({ erreur: "Enregistrez d'abord une clé IzyFacture avant d'activer la facturation automatique." });
    }
    if (!patch.hasOwnProperty("izyfactureAutoFacturation")) patch.izyfactureAutoFacturation = !!autoFacturation;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ erreur: "Rien à modifier." });
  const maj = await db.updateMerchantFields(req.params.id, patch);
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.izyfactureApiKey = maj.izyfactureApiKey;
  entry.merchant.izyfactureAutoFacturation = maj.izyfactureAutoFacturation;
  console.log(`[${req.params.id}] Paramètres IzyFacture mis à jour par ${req.auth.adminUser} : clé ${maj.izyfactureApiKey ? "enregistrée" : "effacée"}, auto-facturation=${maj.izyfactureAutoFacturation}.`);
  const cleClaire = entry.merchant.izyfactureApiKey ? cryptoUtil.dechiffrer(entry.merchant.izyfactureApiKey) : null;
  res.json({
    cleEnregistree: !!entry.merchant.izyfactureApiKey,
    indiceCle: cleClaire ? cryptoUtil.indiceAffichable(cleClaire) : "",
    autoFacturation: entry.merchant.izyfactureAutoFacturation === true
  });
});

// Bouton "Tester la connexion" : verifie une cle (celle deja enregistree, ou une nouvelle envoyee pour
// verification AVANT de l'enregistrer) via GET /me. Ne modifie jamais rien en base.
app.post("/api/:id/izyfacture/tester", protegerAcces, async (req, res) => {
  const entry = engines[req.params.id];
  if (!entry) return res.status(404).json({ erreur: "Marchand inconnu : " + req.params.id });
  if (!estGestionnaireDuMarchand(req, req.params.id)) {
    return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  }
  if (!entry.merchant.optionFacturationIzyfacture) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const cleFournie = req.body && req.body.apiKey ? String(req.body.apiKey).trim() : null;
  const cle = cleFournie || (entry.merchant.izyfactureApiKey ? cryptoUtil.dechiffrer(entry.merchant.izyfactureApiKey) : null);
  if (!cle) return res.status(400).json({ erreur: "Aucune clé à tester : enregistrez-en une ou saisissez-en une pour ce test." });
  try {
    const reponse = await izyfacture.verifierCle(cle);
    res.json({ ok: true, entreprise: reponse.company ? reponse.company.name : null, devise: reponse.company ? reponse.company.currency : null });
  } catch (erreur) {
    res.status(statutReponseExterne(erreur)).json({ ok: false, erreur: erreur.message || "Connexion à IzyFacture impossible.", code: erreur.code || null });
  }
});

// Reessai manuel (bouton "Facturer"/"Réessayer" sur une commande, /admin onglet Commandes) - meme permission
// que la gestion des commandes ("commandes"), pas besoin d'etre gestionnaire : quelqu'un qui traite les
// commandes au quotidien doit pouvoir relancer une facturation en echec, sans jamais voir/gerer la cle
// elle-meme (route separee ci-dessus, reservee au proprietaire).
app.post("/api/:id/commandes/:orderId/izyfacture/facturer", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "commandes"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const order = entry.engine.getOrderById(req.params.orderId);
  const refus = refusFacturationManuelle(entry, order, "facturer");
  if (refus) return res.status(refus.status).json({ erreur: refus.erreur });
  if (!order) return res.status(404).json({ erreur: "Commande introuvable." });
  await tenterFacturationCommande(entry, order, { client: (req.body || {}).client });
  res.json(entry.engine.getOrderById(req.params.orderId));
});

// Etape 59 : « le client veut une facture » apres une vente de la Caisse. Accessible au caissier (role
// « caisse ») comme a l'onglet Commandes ; ne concerne QUE les ventes POS. Nom, telephone, NIU et adresse du
// client sont facultatifs (sans nom : « Client comptoir »). Idempotent : refaire l'appel ne cree pas de doublon.
app.post("/api/:id/pos/vente/:orderId/facture", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, ["caisse", "commandes"]); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const order = entry.engine.getOrderById(req.params.orderId);
  if (!order) return res.status(404).json({ erreur: "Vente introuvable." });
  if (order.source !== "pos") return res.status(400).json({ erreur: "Cette route ne concerne que les ventes de la Caisse." });
  if (order.statut === "Annulée") return res.status(400).json({ erreur: "Cette vente est annulée : impossible de la facturer." });
  const refus = refusFacturationManuelle(entry, order, "facturer");
  if (refus) return res.status(refus.status).json({ erreur: refus.erreur });
  await tenterFacturationCommande(entry, order, { client: (req.body || {}).client });
  const maj = entry.engine.getOrderById(req.params.orderId);
  if (maj.izyfactureStatut === "erreur") return res.status(502).json({ erreur: maj.izyfactureErreur || "La facture n'a pas pu être créée." });
  res.locals.audit = { detail: { vente: "POS-" + String(maj.id).padStart(4, "0"), facture: maj.izyfactureNumero || null } };
  res.json(maj);
});

// Bouton "Enregistrer un paiement" (27-28 sept 2026, /admin onglet Commandes) - POST
// /invoices/{id}/payments cote IzyFacture (voir izyfacture.js, doc API-IZYVENDEUR.md section 5). Meme
// permission que le reessai de facturation ci-dessus ("commandes", pas besoin d'etre gestionnaire) : c'est
// une action operationnelle du quotidien (encaisser un acompte, un paiement a la livraison...), pas un
// reglage sensible comme la cle elle-meme.
app.post("/api/:id/commandes/:orderId/izyfacture/paiement", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "commandes"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const order = entry.engine.getOrderById(req.params.orderId);
  const refus = refusFacturationManuelle(entry, order, "paiement");
  if (refus) return res.status(refus.status).json({ erreur: refus.erreur });
  if (!order) return res.status(404).json({ erreur: "Commande introuvable." });
  if (!order.izyfactureFactureId) return res.status(400).json({ erreur: "Cette commande n'a pas encore de facture IzyFacture — facturez-la d'abord." });
  const montant = parseInt(req.body && req.body.montant, 10);
  if (!montant || montant <= 0) return res.status(400).json({ erreur: "Montant invalide : indiquez un nombre de FCFA supérieur à zéro." });
  const methode = (req.body && req.body.methode) ? String(req.body.methode).trim() : "especes";
  const reference = (req.body && req.body.reference) ? String(req.body.reference).trim().slice(0, 80) : undefined;
  try {
    await enregistrerPaiementCommande(entry, order, { montant, methode, reference });
    res.json(entry.engine.getOrderById(req.params.orderId));
  } catch (erreur) {
    res.status(statutReponseExterne(erreur)).json({ erreur: erreur.message || "Échec de l'enregistrement du paiement auprès d'IzyFacture.", code: erreur.code || null });
  }
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

// Egalement accessible avec le seul role "caisse" (29 septembre 2026) : un(e) caissier(e) a la Caisse POS
// doit pouvoir CONSULTER le catalogue (prix, stock disponible) pour chercher un article a vendre - jamais
// le MODIFIER pour autant (voir PUT ci-dessous, resté strictement reservé au role "catalogue").
app.get("/api/:id/catalogue", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, ["catalogue", "caisse"]); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.getCatalog());
});

app.put("/api/:id/catalogue", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "catalogue"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  // Filet de securite pour l'option payante "Stock illimite" (voir PUT /api/marchands/:id/options-payantes) :
  // /admin cache deja la case a cocher tant que l'option n'est pas debloquee, mais un appel direct a cette
  // route (hors interface) pourrait sinon quand meme glisser stockIllimite:true - on l'ignore silencieusement
  // ici plutot que de rejeter tout l'enregistrement du catalogue pour ca.
  let corps = req.body;
  if (!entry.merchant.optionStockIllimite && Array.isArray(corps)) {
    corps = corps.map((p) => (p && p.stockIllimite ? Object.assign({}, p, { stockIllimite: false }) : p));
  }
  // Filet de securite pour la suppression d'article, reservee au proprietaire du marchand/super-
  // administrateur (29 sept 2026, meme principe que le filet Stock illimite ci-dessus) : /admin masque deja
  // le bouton "Supprimer l'article" pour un(e) employe(e) ayant seulement le role "catalogue" (voir
  // renderCatalogue), mais un appel direct a cette route (hors interface) pourrait sinon quand meme
  // soumettre un catalogue plus court qu'avant - on reinjecte silencieusement les articles manquants
  // plutot que de rejeter tout l'enregistrement (les autres modifications, elles, restent acceptees).
  const catalogueAvant = JSON.parse(JSON.stringify(entry.engine.getCatalog() || []));
  let suppressionsBloquees = [];
  if (!estGestionnaireDuMarchand(req, req.params.id) && Array.isArray(corps)) {
    const catalogueActuel = entry.engine.getCatalog();
    const idsPresents = new Set(corps.filter((p) => p && p.id).map((p) => p.id));
    const manquants = catalogueActuel.filter((p) => p && p.id && !idsPresents.has(p.id));
    if (manquants.length) {
      corps = corps.concat(manquants);
      manquants.forEach((p) => suppressionsBloquees.push({ k: "article_supprime", art: String(p.nom || "").slice(0, 80) }));
    }
    // Etape 40 : meme principe pour les VARIANTES et les PHOTOS - un(e) employe(e) ne supprime rien (il/elle
    // met le stock a 0 pour une variante epuisee). Voir appliquerFiletEmployeCatalogue.
    const filet = appliquerFiletEmployeCatalogue(catalogueActuel, corps);
    corps = filet.catalogue;
    suppressionsBloquees = suppressionsBloquees.concat(filet.restaures);
  }
  const nouveau = entry.engine.updateCatalog(corps);
  if (!nouveau) return res.status(400).json({ erreur: "Corps de requête invalide (tableau attendu)." });
  // Journal : uniquement les vrais changements (un enregistrement sans modification n'ecrit rien).
  const changements = comparerCatalogues(catalogueAvant, nouveau);
  if (changements.length) {
    res.locals.audit = { detail: { changes: changements.slice(0, 200), plus: Math.max(0, changements.length - 200) } };
  } else {
    res.locals.audit = { ignorer: true };
  }
  if (suppressionsBloquees.length) {
    res.locals.auditExtra = [{ action: "suppression_bloquee", statut: "refuse", detail: { changes: suppressionsBloquees.slice(0, 100) } }];
  }
  res.json(nouveau);
});

// -- Caisse POS (29 septembre 2026) -- (permission employe requise : "caisse", ET option payante
// superadmin "optionCaissePos" - voir PUT /api/marchands/:id/options-payantes) : encaissement en boutique
// physique, decremente le MEME stock que le bot WhatsApp (voir creerVentePos dans conversation.js). Une
// vente POS devient une commande normale (statut "Livrée" des la creation, source:"pos") - visible dans
// l'onglet Commandes et comptee dans le Tableau de bord/Rapports existants, sans code de reporting séparé.
app.post("/api/:id/pos/vente", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "caisse"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!entry.merchant.optionCaissePos) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const { lignes, modePaiement, referencePaiement, remiseGlobale, motifRemise } = req.body || {};
  const resultat = entry.engine.creerVentePos({
    lignes, modePaiement, referencePaiement, caissier: req.auth.adminUser, remiseGlobale, motifRemise,
    verifierRemise: (info) => controleRemise(req, info.pourcentEffectif)
  });
  if (resultat.erreur) return res.status(resultat.statut || 400).json({ erreur: resultat.erreur });
  // Etape 59 : seules les ventes avec remise sont tracees dans le journal d'audit (pas chaque vente).
  const rm = resultat.order.remise;
  // Chaque vente reste journalisee comme avant (« vente_caisse ») ; une vente avec remise ajoute une ligne dediee
  // « vente_caisse_remise » (brut, remise, pourcentage, motif) pour retrouver facilement les remises accordees.
  if (rm) {
    res.locals.auditExtra = [{ action: "vente_caisse_remise", statut: "ok", detail: { vente: "POS-" + String(resultat.order.id).padStart(4, "0"), brut: resultat.order.prixBrut, remise: rm.montant, pourcent: rm.pourcentEffectif, motif: rm.motif } }];
  }
  res.status(201).json(resultat.order);
});

// -- Session de caisse : ouverture/fermeture + billetage (29 septembre 2026) -- (meme garde que
// POST /api/:id/pos/vente ci-dessus : role employe "caisse" ET option payante "optionCaissePos"). Chaque
// marchand definit ses propres reglages (coupures/seuil de tolerance/un seul tiroir ou plusieurs) via
// PUT /api/:id/parametres (cle "caisse") - voir plus bas.
app.get("/api/:id/caisse/config", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "caisse"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!entry.merchant.optionCaissePos) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  res.json(entry.engine.getConfigCaisse());
});

app.get("/api/:id/caisse/session/active", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "caisse"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!entry.merchant.optionCaissePos) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  res.json(entry.engine.getSessionCaisseActive(req.auth.adminUser));
});

app.get("/api/:id/caisse/sessions", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "caisse"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!entry.merchant.optionCaissePos) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  res.json(entry.engine.getSessionsCaisse());
});

// Etape 58 : rapport de caisse sur une PERIODE LIBRE (du/au, 366 jours maximum), filtre caissier facultatif.
// JSON par defaut ; ?format=csv&vue=synthese|ventes|sessions (&sep=comma pour la virgule, sinon point-virgule
// pour Excel en francais). Acces : proprietaire, super-administrateur, employes "caisse" ou "rapports".
app.get("/api/:id/caisse/rapport", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, ["caisse", "rapports"]); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!entry.merchant.optionCaissePos) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const r = rapportCaisse.genererRapportCaisse({
    marchand: req.params.id, commandes: entry.engine.getOrders(), sessions: entry.engine.getSessionsCaisse(),
    du: req.query.du, au: req.query.au, caissier: req.query.caissier
  });
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  if (String(req.query.format || "").toLowerCase() === "csv") {
    const vue = rapportCaisse.VUES_CSV.indexOf(String(req.query.vue || "synthese")) !== -1 ? String(req.query.vue || "synthese") : "synthese";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="rapport-caisse-${vue}-${r.du}_${r.au}.csv"`);
    return res.send(rapportCaisse.csv(r, vue, String(req.query.sep || "") === "comma" ? "," : ";"));
  }
  res.json(r);
});

app.post("/api/:id/caisse/session/ouvrir", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "caisse"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!entry.merchant.optionCaissePos) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const { billetage } = req.body || {};
  const resultat = entry.engine.ouvrirSessionCaisse({ billetage, caissier: req.auth.adminUser });
  if (resultat.erreur) return res.status(400).json({ erreur: resultat.erreur });
  res.status(201).json(resultat.session);
});

app.post("/api/:id/caisse/session/fermer", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "caisse"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!entry.merchant.optionCaissePos) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const { sessionId, billetageFermeture, raisonEcart } = req.body || {};
  const resultat = entry.engine.fermerSessionCaisse({ sessionId, billetageFermeture, raisonEcart, caissier: req.auth.adminUser });
  if (resultat.erreur) return res.status(400).json({ erreur: resultat.erreur });
  res.json(resultat.session);
});

// Analyse une ligne CSV en tenant compte des guillemets (un champ peut contenir le separateur ou des
// guillemets echappes en double, comme le fait Excel a l'export) - jamais de simple split(separateur) qui
// casserait sur un nom d'article contenant une virgule/un point-virgule.
function parserLigneCsv(ligne, separateur) {
  const champs = [];
  let champ = "";
  let dansGuillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (ligne[i + 1] === '"') { champ += '"'; i++; } else { dansGuillemets = false; }
      } else champ += c;
    } else if (c === '"') {
      dansGuillemets = true;
    } else if (c === separateur) {
      champs.push(champ); champ = "";
    } else champ += c;
  }
  champs.push(champ);
  return champs.map((c) => c.trim());
}

// Accepte "17000", "17 000" (espace/espace insecable), "17,000" - jamais de valeur negative/non numerique.
function parserPrixFcfa(texte) {
  const nettoye = String(texte == null ? "" : texte).replace(/[^\d.,\-]/g, "").replace(/,/g, "");
  const n = parseFloat(nettoye);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// Import en masse du catalogue depuis un fichier CSV (Etape 23, 27 sept 2026 - demande apres l'onboarding
// d'un nouveau marchand avec plusieurs dizaines d'articles a saisir a la main). Colonnes attendues (l'ordre
// n'importe pas, la casse/les accents non plus - detectees par en-tete) : "Categorie", "Nom", "Prix"
// (obligatoires : Nom + Prix), et facultatives "Stock initial", "Seuil d'alerte", "Couleur", "Taille".
// Separateur virgule OU point-virgule, detecte automatiquement sur la premiere ligne. Plusieurs lignes
// partageant EXACTEMENT le meme couple Categorie+Nom deviennent les variantes d'un seul article (permet
// d'importer un catalogue avec de vraies variantes couleur/taille, pas seulement le cas le plus courant
// "un article = une ligne"). Fusionne TOUJOURS avec le catalogue deja enregistre (n'ecrase jamais les
// articles existants, contrairement a PUT /api/:id/catalogue ci-dessus) et ignore silencieusement toute
// ligne dont le nom existe deja (comparaison insensible a la casse/aux espaces) pour proteger contre un
// double-import accidentel si le meme fichier est renvoye deux fois.
app.post("/api/:id/catalogue/importer", protegerAcces, uploadFichierCatalogue.single("fichier"), (req, res) => {
  const entry = getMarchandAutorise(req, res, "catalogue"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"fichier\" attendu)." });

  const texte = req.file.buffer.toString("utf8").replace(/^﻿/, ""); // retire un BOM Excel eventuel
  const lignes = texte.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (!lignes.length) return res.status(400).json({ erreur: "Fichier vide." });

  const separateur = lignes[0].indexOf(";") !== -1 ? ";" : ",";
  const entetes = parserLigneCsv(lignes[0], separateur).map((h) => h.toLowerCase());
  const idx = (motCle) => entetes.findIndex((h) => h.indexOf(motCle) !== -1);
  const iCat = idx("categorie");
  const iNom = idx("nom");
  const iPrix = idx("prix");
  const iStock = idx("stock");
  const iSeuil = idx("seuil");
  const iCouleur = idx("couleur");
  const iTaille = idx("taille");
  if (iNom === -1 || iPrix === -1) {
    return res.status(400).json({ erreur: "Colonnes attendues introuvables (au minimum \"Nom\" et \"Prix\")." });
  }

  const catalogueActuel = entry.engine.getCatalog();
  const nomsExistants = new Set(catalogueActuel.map((p) => String(p.nom || "").trim().toLowerCase()));

  const groupes = new Map(); // "categorie||nom" -> { cat, nom, variantes: [] }
  const doublons = [];
  const erreurs = [];

  for (let i = 1; i < lignes.length; i++) {
    const champs = parserLigneCsv(lignes[i], separateur);
    const nom = (champs[iNom] || "").trim();
    if (!nom) continue;
    const cat = iCat !== -1 ? (champs[iCat] || "").trim() : "";
    const prix = parserPrixFcfa(champs[iPrix]);
    if (prix == null) { erreurs.push("ligne " + (i + 1) + " (" + nom + ") : prix invalide"); continue; }
    if (nomsExistants.has(nom.toLowerCase())) {
      if (doublons.indexOf(nom) === -1) doublons.push(nom);
      continue;
    }
    const stockReel = iStock !== -1 ? (parseInt(champs[iStock], 10) || 0) : 0;
    const seuilAlerte = iSeuil !== -1 ? (parseInt(champs[iSeuil], 10) || 0) : 2;
    const couleur = (iCouleur !== -1 && champs[iCouleur]) ? champs[iCouleur] : "-";
    const taille = (iTaille !== -1 && champs[iTaille]) ? champs[iTaille] : "Unique";

    const cle = cat.toLowerCase() + "||" + nom.toLowerCase();
    if (!groupes.has(cle)) groupes.set(cle, { cat, nom, variantes: [] });
    groupes.get(cle).variantes.push({ couleur, taille, prix, stockReel, seuilAlerte });
  }

  const nouveauxArticles = Array.from(groupes.values()).map((g, i) => ({
    id: "imp" + Date.now() + "_" + i,
    nom: g.nom,
    cat: g.cat,
    variantes: g.variantes
  }));

  if (!nouveauxArticles.length) {
    return res.json({ ajoutes: 0, doublonsIgnores: doublons, erreurs });
  }

  const nouveau = entry.engine.updateCatalog(catalogueActuel.concat(nouveauxArticles));
  res.json({ ajoutes: nouveauxArticles.length, doublonsIgnores: doublons, erreurs, catalogue: nouveau });
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
  // Etape 40 : un(e) employe(e) peut AJOUTER une photo mais jamais en supprimer (proprietaire/super-admin seulement).
  if (!estGestionnaireDuMarchand(req, req.params.id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ erreur: "url requise." });
  const produit = entry.engine.supprimerPhotoProduit(req.params.productId, url);
  if (!produit) return res.status(404).json({ erreur: "Article introuvable." });
  await storage.supprimerPhotoProduit(url); // best-effort, ne bloque jamais la reponse
  res.json({ ok: true, produit });
});

// Permission "commandes", role a part entiere depuis le 25 septembre 2026 (voir ROLES_EMPLOYE_VALIDES) :
// voir/traiter les commandes ne depend plus du role "conversations" - un(e) employe(e) peut avoir l'un
// sans l'autre (ex: quelqu'un qui prepare/expedie les commandes sans jamais echanger avec les clients).
app.get("/api/:id/commandes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "commandes"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.getOrders());
});

// Etape 49 : corriger le telephone et/ou l'adresse d'une commande depuis /admin (le client s'est trompe et
// previent le marchand par un autre canal). Meme permission "commandes" que le changement de statut ; jamais
// pour une vente comptoir (pos), ni une commande du simulateur ; l'adresse d'un retrait n'est pas modifiable.
app.put("/api/:id/commandes/:orderId/coordonnees", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "commandes"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { telephone, adresse } = req.body || {};
  const r = entry.engine.updateOrderContact(req.params.orderId, { telephone, adresse });
  if (r.erreur === "introuvable") return res.status(404).json({ erreur: "Commande introuvable." });
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  res.json(r.order);
});

app.put("/api/:id/commandes/:orderId/statut", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "commandes"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { statut, raisonAnnulation } = req.body || {};
  // Statut AVANT changement - necessaire pour savoir, une fois la commande mise a jour, si elle vient
  // REELLEMENT de basculer vers "Confirmée"/"Annulée" (voir le pont IzyFacture juste apres) plutot que d'y
  // etre deja et d'etre simplement re-enregistree avec le meme statut.
  const avant = entry.engine.getOrderById(req.params.orderId);
  const statutAvant = avant ? avant.statut : null;
  // Le 4e argument decide si un message WhatsApp de notification part vers le CLIENT (voir
  // notifierChangementStatutCommande dans conversation.js) - reserve aux marchands debloques par le
  // super-administrateur (option payante "Notifications de statut", voir /options-payantes ci-dessus).
  // L'engine lui-meme decide ensuite, statut par statut, si ce marchand l'a active et avec quel texte.
  const order = entry.engine.updateOrderStatus(req.params.orderId, statut, raisonAnnulation, entry.merchant.optionNotificationsStatut === true);
  if (!order) return res.status(404).json({ erreur: "Commande introuvable." });
  res.json(order);

  // Etape 57 : une vente de la Caisse POS annulee est retenue pour le journal (ligne d'annulation datee).
  if (order.source === "pos" && order.statut === "Annulée" && entry.facturation) entry.facturation.noterEvenementPos(order.id, "annulee");

  // Pont IzyFacture - APRES avoir repondu (jamais bloquant pour la commande, voir doc API-IZYVENDEUR.md
  // section 9, regle 1) : facturation automatique a la confirmation, avoir automatique a l'annulation d'une
  // commande deja facturee. Rien ne se passe si la cle/l'auto-facturation ne sont pas configurees.
  if (statutAvant !== order.statut && facturationPeutAgir(entry, order)) {
    if (order.statut === "Confirmée" && facturationAutoActive(entry) && !order.izyfactureFactureId) {
      tenterFacturationCommande(entry, order).catch((erreur) =>
        console.error(`[${req.params.id}] Echec inattendu de la facturation IzyFacture (commande #${order.id}) :`, erreur)
      );
    } else if (order.statut === "Annulée" && order.izyfactureFactureId && order.izyfactureStatut !== "avoir") {
      tenterAvoirCommande(entry, order, order.raisonAnnulation).catch((erreur) =>
        console.error(`[${req.params.id}] Echec inattendu de l'avoir IzyFacture (commande #${order.id}) :`, erreur)
      );
    }
  }
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
  const avant = (entry.engine.getServices() || []).map((x) => ({ id: x.id, photos: (x.photos || []).slice() }));
  const nouveau = entry.engine.updateServices(req.body);
  if (!nouveau) return res.status(400).json({ erreur: "Corps de requête invalide (tableau attendu)." });
  // Etape 77 : un service supprime emporte ses photos (menage best-effort sur R2).
  entry.engine.photosOrphelinesServices(avant, nouveau).forEach((u) => { storage.supprimerPhotoProduit(u).catch(() => {}); });
  res.json(nouveau);
});

// Etape 77 : photos d'un service (3 maximum). Meme hebergement (Cloudflare R2) et memes regles que les photos d'articles :
// un(e) employe(e) avec le role « rendezvous » peut AJOUTER, seul le proprietaire / super-administrateur peut SUPPRIMER.
// Le bot envoie ces photos au client au moment ou il choisit le service (voir conversationService.js).
app.post("/api/:id/services/:serviceId/photos", protegerAcces, uploadPhoto.single("photo"), async (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  if (!storage.estConfigure()) {
    return res.status(503).json({ erreur: "Hébergement des photos non configuré sur le serveur (variables R2_* manquantes sur Render). Voir le README, section « Photos des articles »." });
  }
  const service = entry.engine.getServices().filter((x) => x.id === req.params.serviceId)[0];
  if (!service) return res.status(404).json({ erreur: "Service introuvable (enregistrez d'abord la liste des services)." });
  if ((service.photos || []).length >= photosElements.MAX_PHOTOS) return res.status(409).json({ erreur: "3 photos au maximum par service : supprimez-en une avant d'en ajouter." });
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"photo\" requis)." });
  try {
    const url = await storage.uploaderPhotoProduit({ merchantKey: req.params.id, productId: "service-" + service.id, buffer: req.file.buffer, mimeType: req.file.mimetype });
    const r = entry.engine.ajouterPhotoService(service.id, url);
    if (r.statut !== "ok") {
      await storage.supprimerPhotoProduit(url).catch(() => {});
      return res.status(r.statut === "plein" ? 409 : r.statut === "introuvable" ? 404 : 400).json({ erreur: r.statut === "plein" ? "3 photos au maximum par service : supprimez-en une avant d'en ajouter." : "Photo non ajoutée." });
    }
    res.status(201).json({ url, service: r.service });
  } catch (erreur) {
    res.status(400).json({ erreur: erreur.message || "Échec de l'envoi de la photo." });
  }
});

app.delete("/api/:id/services/:serviceId/photos", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (!estGestionnaireDuMarchand(req, req.params.id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ erreur: "url requise." });
  const service = entry.engine.supprimerPhotoService(req.params.serviceId, url);
  if (!service) return res.status(404).json({ erreur: "Service introuvable." });
  await storage.supprimerPhotoProduit(url).catch(() => {}); // best-effort
  res.json({ ok: true, service });
});

// Etape 61 : import en masse des services depuis un fichier CSV (meme principe que le catalogue). Colonnes (ordre
// libre, casse et accents ignores) : "Nom", "Duree" (minutes, 5 a 720) et "Prix" (FCFA), les trois obligatoires.
// Separateur virgule OU point-virgule. Fusionne TOUJOURS avec les services deja enregistres (n'ecrase rien) et
// ignore tout nom deja present (comparaison insensible a la casse), pour qu'un fichier renvoye deux fois ne
// cree pas de doublons.
function sansAccents(t) { return String(t == null ? "" : t).normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
app.post("/api/:id/services/importer", protegerAcces, uploadFichierCatalogue.single("fichier"), (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"fichier\" attendu)." });
  const texte = req.file.buffer.toString("utf8").replace(/^\uFEFF/, "");
  const lignes = texte.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (!lignes.length) return res.status(400).json({ erreur: "Fichier vide." });
  if (lignes.length > 301) return res.status(400).json({ erreur: "Fichier trop long (300 services maximum par import)." });
  const separateur = lignes[0].indexOf(";") !== -1 ? ";" : ",";
  const entetes = parserLigneCsv(lignes[0], separateur).map((h) => sansAccents(h).toLowerCase());
  const idx = (motCle) => entetes.findIndex((h) => h.indexOf(motCle) !== -1);
  const iNom = idx("nom"), iDuree = idx("duree"), iPrix = idx("prix");
  if (iNom === -1 || iDuree === -1 || iPrix === -1) {
    return res.status(400).json({ erreur: "Colonnes attendues introuvables (\"Nom\", \"Durée (minutes)\" et \"Prix\")." });
  }
  const actuels = entry.engine.getServices();
  const vus = new Set(actuels.map((x) => String(x.nom || "").trim().toLowerCase()));
  const nouveaux = [], doublons = [], erreurs = [];
  const base = Date.now();
  for (let i = 1; i < lignes.length; i++) {
    const champs = parserLigneCsv(lignes[i], separateur);
    const nom = (champs[iNom] || "").trim();
    if (!nom) continue;
    if (nom.length > 80) { erreurs.push("ligne " + (i + 1) + " (" + nom.slice(0, 30) + "…) : nom trop long (80 caractères maximum)"); continue; }
    const duree = parseInt(String(champs[iDuree] || "").replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(duree) || duree < 5 || duree > 720) { erreurs.push("ligne " + (i + 1) + " (" + nom + ") : durée invalide (5 à 720 minutes)"); continue; }
    const prix = parserPrixFcfa(champs[iPrix]);
    if (prix == null) { erreurs.push("ligne " + (i + 1) + " (" + nom + ") : prix invalide"); continue; }
    const cle = nom.toLowerCase();
    if (vus.has(cle)) { if (doublons.indexOf(nom) === -1) doublons.push(nom); continue; }
    vus.add(cle);
    nouveaux.push({ id: "s" + base + "_" + nouveaux.length, nom, dureeMinutes: duree, prix });
  }
  if (!nouveaux.length) return res.json({ ajoutes: 0, doublonsIgnores: doublons, erreurs });
  const liste = entry.engine.updateServices(actuels.concat(nouveaux));
  res.json({ ajoutes: nouveaux.length, doublonsIgnores: doublons, erreurs, services: liste });
});

// Etape 61 : contexte minimal pour le dialogue « Déplacer » (fuseau du marchand, praticiens) - sous la permission
// "rendezvous" : un employe qui gere les rendez-vous n'a pas forcement le droit de lire tous les Parametres.
app.get("/api/:id/rendezvous-contexte", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const r = (entry.engine.getSettings && entry.engine.getSettings()) || {};
  res.json({
    fuseau: sh.fuseauValide(r.fuseau) ? r.fuseau : sh.FUSEAU_PAR_DEFAUT,
    praticiens: (Array.isArray(r.praticiens) ? r.praticiens : []).map((x) => ({ id: x.id, nom: x.nom }))
  });
});

// Etape 61 : la gerante deplace un rendez-vous (nouvelle date/heure, dans le fuseau du marchand).
app.put("/api/:id/rendezvous/:apptId/deplacer", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const { date, heure, praticienId, horsHoraires } = req.body || {};
  const r = entry.engine.deplacerAppointment(req.params.apptId, {
    date, heure, praticienId: praticienId || null, horsHoraires: horsHoraires === true,
    par: (req.auth && req.auth.adminUser) || null
  });
  if (r.erreur === "introuvable") return res.status(404).json({ erreur: r.message });
  if (r.erreur) return res.status(400).json({ erreur: r.message, code: r.erreur });
  res.json(r.appt);
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
  // Statut AVANT changement (meme logique que pour les commandes) : on ne facture que si le rendez-vous vient
  // REELLEMENT de passer a "Honoré", pas s'il y etait deja.
  const avant = entry.engine.getAppointmentById(req.params.apptId);
  const statutAvant = avant ? avant.statut : null;
  const appt = entry.engine.updateAppointmentStatus(req.params.apptId, statut, raisonAnnulation);
  if (!appt) return res.status(404).json({ erreur: "Rendez-vous introuvable." });
  if (appt.erreur) return res.status(409).json({ erreur: appt.message, code: appt.erreur });
  res.json(appt);

  // Pont IzyFacture (Etape 46) - APRES avoir repondu, jamais bloquant : facture a l'"Honoré" (la prestation a
  // eu lieu, le client a paye sur place), avoir si le rendez-vous est annule APRES avoir ete facture. Les
  // rendez-vous du Simulateur ne sont jamais factures.
  if (statutAvant !== appt.statut && appt.source !== "simulateur" && facturationPeutAgir(entry, appt)) {
    if (appt.statut === "Honoré" && facturationAutoActive(entry) && !appt.izyfactureFactureId) {
      tenterFacturationCommande(entry, appt).catch((erreur) =>
        console.error(`[${req.params.id}] Echec inattendu de la facturation IzyFacture (rendez-vous #${appt.id}) :`, erreur)
      );
    } else if (appt.statut === "Annulé" && appt.izyfactureFactureId && appt.izyfactureStatut !== "avoir") {
      tenterAvoirCommande(entry, appt, appt.raisonAnnulation).catch((erreur) =>
        console.error(`[${req.params.id}] Echec inattendu de l'avoir IzyFacture (rendez-vous #${appt.id}) :`, erreur)
      );
    }
  }
});

// Facturation manuelle / reessai (bouton "Facturer"/"Réessayer" de l'onglet Rendez-vous). Meme permission que
// la gestion des rendez-vous. Refuse de facturer un rendez-vous qui n'a pas eu lieu (Nouvelle, Confirmé,
// Absent, Annulé) : une facture n'a de sens que pour une prestation honoree - sauf s'il en a deja une (un
// reessai apres changement de statut ne doit pas etre bloque).
app.post("/api/:id/rendezvous/:apptId/izyfacture/facturer", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const appt = entry.engine.getAppointmentById(req.params.apptId);
  const refus = refusFacturationManuelle(entry, appt, "facturer");
  if (refus) return res.status(refus.status).json({ erreur: refus.erreur });
  if (!appt || appt.source === "simulateur") return res.status(404).json({ erreur: "Rendez-vous introuvable." });
  if (appt.statut !== "Honoré" && !appt.izyfactureFactureId) {
    return res.status(400).json({ erreur: "Seul un rendez-vous au statut « Honoré » peut être facturé." });
  }
  await tenterFacturationCommande(entry, appt);
  res.json(entry.engine.getAppointmentById(req.params.apptId));
});

// Enregistrer un paiement sur la facture d'un rendez-vous (meme comportement que pour une commande).
app.post("/api/:id/rendezvous/:apptId/izyfacture/paiement", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return;
  if (entry.engine.type !== "service") return res.status(400).json({ erreur: "Ce marchand n'est pas de type service." });
  const appt = entry.engine.getAppointmentById(req.params.apptId);
  const refus = refusFacturationManuelle(entry, appt, "paiement");
  if (refus) return res.status(refus.status).json({ erreur: refus.erreur });
  if (!appt || appt.source === "simulateur") return res.status(404).json({ erreur: "Rendez-vous introuvable." });
  if (!appt.izyfactureFactureId) return res.status(400).json({ erreur: "Ce rendez-vous n'a pas encore de facture IzyFacture — facturez-le d'abord." });
  const montant = parseInt(req.body && req.body.montant, 10);
  if (!montant || montant <= 0) return res.status(400).json({ erreur: "Montant invalide : indiquez un nombre de FCFA supérieur à zéro." });
  const methode = (req.body && req.body.methode) ? String(req.body.methode).trim() : "especes";
  const reference = (req.body && req.body.reference) ? String(req.body.reference).trim().slice(0, 80) : undefined;
  try {
    await enregistrerPaiementCommande(entry, appt, { montant, methode, reference });
    res.json(entry.engine.getAppointmentById(req.params.apptId));
  } catch (erreur) {
    res.status(statutReponseExterne(erreur)).json({ erreur: erreur.message || "Échec de l'enregistrement du paiement auprès d'IzyFacture.", code: erreur.code || null });
  }
});

// -- Marchand hebergement (Etape 65) : chambres par type, sejours, calendrier d'occupation --
// Meme permission employe que les rendez-vous (« rendezvous » = les reservations de ce marchand). Ces routes ne
// repondent que pour un marchand de type hebergement ; le type lui-meme n'est accorde que par le
// super-administrateur a la creation (POST /api/marchands, reserve au super-administrateur).
function entreeHebergement(req, res) {
  let entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return null;
  // Etape 66 : sur un marchand a plusieurs volets, ces routes visent toujours le volet hebergement.
  entry = vueEntree(entry, "hebergement");
  if (entry.engine.type !== "hebergement") { res.status(400).json({ erreur: "Ce marchand n'est pas de type hébergement." }); return null; }
  return entry;
}

app.get("/api/:id/chambres", protegerAcces, (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  res.json(entry.engine.getChambres());
});

app.put("/api/:id/chambres", protegerAcces, (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  const avant = (entry.engine.getChambres() || []).map((x) => ({ id: x.id, photos: (x.photos || []).slice() }));
  const nouveau = entry.engine.updateChambres(req.body);
  if (!nouveau) return res.status(400).json({ erreur: "Corps de requête invalide (tableau attendu)." });
  // Etape 77 : un type de chambre supprime emporte ses photos (menage best-effort sur R2).
  entry.engine.photosOrphelinesChambres(avant, nouveau).forEach((u) => { storage.supprimerPhotoProduit(u).catch(() => {}); });
  res.json(nouveau);
});

// Etape 77 : photos d'un type de chambre (3 maximum), memes regles que celles des services (ajout : role « rendezvous » ;
// suppression : proprietaire / super-administrateur). Envoyees au client quand il choisit la chambre.
app.post("/api/:id/chambres/:chambreId/photos", protegerAcces, uploadPhoto.single("photo"), async (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  if (!storage.estConfigure()) {
    return res.status(503).json({ erreur: "Hébergement des photos non configuré sur le serveur (variables R2_* manquantes sur Render). Voir le README, section « Photos des articles »." });
  }
  const chambre = entry.engine.getChambres().filter((x) => x.id === req.params.chambreId)[0];
  if (!chambre) return res.status(404).json({ erreur: "Type de chambre introuvable (enregistrez d'abord la liste des chambres)." });
  if ((chambre.photos || []).length >= photosElements.MAX_PHOTOS) return res.status(409).json({ erreur: "3 photos au maximum par type de chambre : supprimez-en une avant d'en ajouter." });
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"photo\" requis)." });
  try {
    const url = await storage.uploaderPhotoProduit({ merchantKey: req.params.id, productId: "chambre-" + chambre.id, buffer: req.file.buffer, mimeType: req.file.mimetype });
    const r = entry.engine.ajouterPhotoChambre(chambre.id, url);
    if (r.statut !== "ok") {
      await storage.supprimerPhotoProduit(url).catch(() => {});
      return res.status(r.statut === "plein" ? 409 : r.statut === "introuvable" ? 404 : 400).json({ erreur: r.statut === "plein" ? "3 photos au maximum par type de chambre : supprimez-en une avant d'en ajouter." : "Photo non ajoutée." });
    }
    res.status(201).json({ url, chambre: r.chambre });
  } catch (erreur) {
    res.status(400).json({ erreur: erreur.message || "Échec de l'envoi de la photo." });
  }
});

app.delete("/api/:id/chambres/:chambreId/photos", protegerAcces, async (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  if (!estGestionnaireDuMarchand(req, req.params.id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ erreur: "url requise." });
  const chambre = entry.engine.supprimerPhotoChambre(req.params.chambreId, url);
  if (!chambre) return res.status(404).json({ erreur: "Type de chambre introuvable." });
  await storage.supprimerPhotoProduit(url).catch(() => {}); // best-effort
  res.json({ ok: true, chambre });
});

// Import CSV des types de chambre. Colonnes (ordre libre, casse/accents ignores) : "Nom", "Nombre" (de chambres),
// "Prix" (FCFA par nuit) et, facultatif, "Capacite" (personnes, 2 par defaut). Fusionne avec l'existant, ignore les
// noms deja presents (un fichier renvoye deux fois ne cree pas de doublons).
app.post("/api/:id/chambres/importer", protegerAcces, uploadFichierCatalogue.single("fichier"), (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"fichier\" attendu)." });
  const texte = req.file.buffer.toString("utf8").replace(/^﻿/, "");
  const lignes = texte.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (!lignes.length) return res.status(400).json({ erreur: "Fichier vide." });
  if (lignes.length > 201) return res.status(400).json({ erreur: "Fichier trop long (200 types de chambre maximum par import)." });
  const separateur = lignes[0].indexOf(";") !== -1 ? ";" : ",";
  const entetes = parserLigneCsv(lignes[0], separateur).map((h) => sansAccents(h).toLowerCase());
  const idx = (motCle) => entetes.findIndex((h) => h.indexOf(motCle) !== -1);
  const iNom = idx("nom"), iNombre = idx("nombre"), iPrix = idx("prix"), iCap = idx("capacit");
  if (iNom === -1 || iNombre === -1 || iPrix === -1) {
    return res.status(400).json({ erreur: "Colonnes attendues introuvables (\"Nom\", \"Nombre\" de chambres et \"Prix\" par nuit ; \"Capacité\" facultative)." });
  }
  const actuels = entry.engine.getChambres();
  const vus = new Set(actuels.map((x) => String(x.nom || "").trim().toLowerCase()));
  const nouveaux = [], doublons = [], erreurs = [];
  const base = Date.now();
  for (let i = 1; i < lignes.length; i++) {
    const champs = parserLigneCsv(lignes[i], separateur);
    const nom = (champs[iNom] || "").trim();
    if (!nom) continue;
    if (nom.length > 80) { erreurs.push("ligne " + (i + 1) + " (" + nom.slice(0, 30) + "…) : nom trop long (80 caractères maximum)"); continue; }
    const nombre = parseInt(String(champs[iNombre] || "").replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(nombre) || nombre < 1 || nombre > 500) { erreurs.push("ligne " + (i + 1) + " (" + nom + ") : nombre de chambres invalide (1 à 500)"); continue; }
    const prix = parserPrixFcfa(champs[iPrix]);
    if (prix == null) { erreurs.push("ligne " + (i + 1) + " (" + nom + ") : prix invalide"); continue; }
    let capacite = 2;
    if (iCap !== -1 && String(champs[iCap] || "").trim() !== "") {
      capacite = parseInt(String(champs[iCap]).replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(capacite) || capacite < 1 || capacite > 50) { erreurs.push("ligne " + (i + 1) + " (" + nom + ") : capacité invalide (1 à 50 personnes)"); continue; }
    }
    const cle = nom.toLowerCase();
    if (vus.has(cle)) { if (doublons.indexOf(nom) === -1) doublons.push(nom); continue; }
    vus.add(cle);
    nouveaux.push({ id: "c" + base + "_" + nouveaux.length, nom, nombre, prix, capacite, description: "" });
  }
  if (!nouveaux.length) return res.json({ ajoutes: 0, doublonsIgnores: doublons, erreurs });
  const liste = entry.engine.updateChambres(actuels.concat(nouveaux));
  res.json({ ajoutes: nouveaux.length, doublonsIgnores: doublons, erreurs, chambres: liste });
});

app.get("/api/:id/sejours", protegerAcces, (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  res.json(entry.engine.getSejours());
});

// Nouveau sejour saisi par la reception (appel, comptoir).
app.post("/api/:id/sejours", protegerAcces, (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  const b = req.body || {};
  const r = entry.engine.creerSejourAdmin({
    chambreId: b.chambreId, arrivee: b.arrivee, depart: b.depart, nuits: b.nuits, personnes: b.personnes,
    clientNom: b.clientNom, telephone: b.telephone, statut: b.statut, par: (req.auth && req.auth.adminUser) || null
  });
  if (r.erreur === "occupe") return res.status(409).json({ erreur: r.message, code: r.erreur });
  if (r.erreur) return res.status(400).json({ erreur: r.message, code: r.erreur });
  res.status(201).json(r.sejour);
});

app.put("/api/:id/sejours/:sejourId/deplacer", protegerAcces, (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  const b = req.body || {};
  const r = entry.engine.deplacerSejour(req.params.sejourId, {
    chambreId: b.chambreId, arrivee: b.arrivee, depart: b.depart, nuits: b.nuits, personnes: b.personnes,
    par: (req.auth && req.auth.adminUser) || null
  });
  if (r.erreur === "introuvable") return res.status(404).json({ erreur: r.message });
  if (r.erreur === "occupe") return res.status(409).json({ erreur: r.message, code: r.erreur });
  if (r.erreur) return res.status(400).json({ erreur: r.message, code: r.erreur });
  res.json(r.sejour);
});

app.put("/api/:id/sejours/:sejourId/statut", protegerAcces, (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  const { statut, raisonAnnulation } = req.body || {};
  const s = entry.engine.updateSejourStatut(req.params.sejourId, statut, raisonAnnulation);
  if (!s) return res.status(404).json({ erreur: "Réservation introuvable." });
  if (s.erreur === "occupe") return res.status(409).json({ erreur: s.message, code: s.erreur });
  if (s.erreur) return res.status(400).json({ erreur: s.message, code: s.erreur });
  res.json(s);
});

// Calendrier d'occupation : ?debut=AAAA-MM-JJ&jours=14 (62 maximum).
app.get("/api/:id/calendrier-chambres", protegerAcces, (req, res) => {
  const entry = entreeHebergement(req, res); if (!entry) return;
  res.json(entry.engine.getCalendrier(req.query && req.query.debut ? String(req.query.debut) : null, req.query && req.query.jours));
});

// -- Marchand transport (Etape 74) : lignes (arrets, classes, tarifs par paire d'arrets), departs (horaires, quotas WhatsApp),
// reservations, manifeste. Meme permission employe que les autres reservations (« rendezvous »). Ces routes visent toujours le volet
// transport ; ce volet n'est accorde que par le super-administrateur (POST /api/marchands, PUT /api/marchands/:id/module-secondaire).
// La CNI des voyageurs n'est JAMAIS renvoyee par ces routes, sauf par POST /transport/manifeste (journalisee) : tout le reste la masque.
function entreeTransport(req, res) {
  let entry = getMarchandAutorise(req, res, "rendezvous"); if (!entry) return null;
  entry = vueEntree(entry, "transport");
  if (entry.engine.type !== "transport") { res.status(400).json({ erreur: "Ce marchand n'a pas de volet transport." }); return null; }
  return entry;
}

app.get("/api/:id/transport/lignes", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  res.json(entry.engine.getLignes());
});
app.put("/api/:id/transport/lignes", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const r = entry.engine.updateLignes(req.body);
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  res.json(r.lignes);
});
app.post("/api/:id/transport/lignes/:ligneId/generer-tarifs", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const r = entry.engine.genererTarifs(req.params.ligneId, req.body && req.body.base);
  if (r.erreur) return res.status(404).json({ erreur: r.erreur });
  res.json(r.ligne);
});
app.get("/api/:id/transport/departs", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  res.json(entry.engine.getDeparts());
});
app.put("/api/:id/transport/departs", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const r = entry.engine.updateDeparts(req.body);
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  res.json(r.departs);
});
app.get("/api/:id/transport/occupation", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const o = entry.engine.getOccupation(String(req.query.departId || ""), String(req.query.date || ""));
  if (!o) return res.status(404).json({ erreur: "Départ ou date introuvable." });
  res.json(o);
});
app.get("/api/:id/transport/reservations", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const q = req.query || {};
  res.json(entry.engine.getReservations({ statut: q.statut ? String(q.statut) : null, departId: q.departId ? String(q.departId) : null, date: q.date ? String(q.date) : null }));
});
app.put("/api/:id/transport/reservations/:resId/statut", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const { statut, raison } = req.body || {};
  const r = entry.engine.updateReservationStatut(req.params.resId, statut, raison, (req.auth && req.auth.adminUser) || null);
  if (!r) return res.status(404).json({ erreur: "Réservation introuvable." });
  if (r.erreur === "occupe") return res.status(409).json({ erreur: r.message, code: r.erreur });
  if (r.erreur) return res.status(400).json({ erreur: r.message, code: r.erreur });
  res.json(r);
});
// Envoi du billet au client : action EXPLICITE de l'equipe (aucun envoi automatique).
app.post("/api/:id/transport/reservations/:resId/envoyer-billet", protegerAcces, async (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  try {
    const r = await entry.engine.envoyerBillet(req.params.resId);
    if (r.erreur === "introuvable") return res.status(404).json({ erreur: "Réservation introuvable." });
    if (r.erreur) return res.status(400).json({ erreur: r.message, code: r.erreur });
    res.json({ ok: true });
  } catch (erreur) {
    console.error("[" + req.params.id + "] Echec de l'envoi du billet :", erreur);
    res.status(502).json({ erreur: "Le billet n'a pas pu être envoyé (WhatsApp). Réessayez ou contactez le client." });
  }
});
// Manifeste d'un depart : SEUL endroit ou la CNI est dechiffree. POST (et non GET) pour que chaque consultation soit journalisee.
app.post("/api/:id/transport/manifeste", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const b = req.body || {};
  const m = entry.engine.getManifeste(String(b.departId || ""), String(b.date || ""), true);
  if (!m) return res.status(404).json({ erreur: "Départ ou date introuvable." });
  res.json(m);
});
// Etape 75 : import CSV (fusion, jamais d'ecrasement). Fichier 1 : lignes + arrets + classes + tarifs ; fichier 2 : departs + quotas.
// Modeles telechargeables (= l'exemple train Douala - Yaounde + navette d'aeroport).
app.get("/api/:id/transport/modele/:quoi", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const lignes = req.params.quoi === "lignes";
  if (!lignes && req.params.quoi !== "departs") return res.status(404).json({ erreur: "Modèle inconnu." });
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", "attachment; filename=\"modele_import_" + (lignes ? "lignes" : "departs") + "_transport.csv\"");
  res.send(lignes ? importTransport.MODELE_LIGNES : importTransport.MODELE_DEPARTS);
});
app.post("/api/:id/transport/lignes/importer", protegerAcces, uploadFichierCatalogue.single("fichier"), (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"fichier\" attendu)." });
  const actuelles = entry.engine.getLignes();
  const r = importTransport.analyserLignes(req.file.buffer.toString("utf8"), actuelles, { parserLigneCsv }, createTransportEngine.calculerTarifs);
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  if (!r.nouvelles.length) return res.json({ ajoutes: 0, doublonsIgnores: r.doublons, erreurs: r.erreurs });
  const m = entry.engine.updateLignes(actuelles.concat(r.nouvelles));
  if (m.erreur) return res.status(400).json({ erreur: m.erreur });
  res.json({ ajoutes: r.nouvelles.length, doublonsIgnores: r.doublons, erreurs: r.erreurs });
});
app.post("/api/:id/transport/departs/importer", protegerAcces, uploadFichierCatalogue.single("fichier"), (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"fichier\" attendu)." });
  const lignes = entry.engine.getLignes();
  const ids = new Set(lignes.map((l) => l.id));
  const actuels = entry.engine.getDeparts().filter((d) => ids.has(d.ligneId));
  const r = importTransport.analyserDeparts(req.file.buffer.toString("utf8"), lignes, actuels, { parserLigneCsv });
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  if (!r.nouveaux.length) return res.json({ ajoutes: 0, doublonsIgnores: r.doublons, erreurs: r.erreurs });
  const m = entry.engine.updateDeparts(actuels.concat(r.nouveaux));
  if (m.erreur) return res.status(400).json({ erreur: m.erreur });
  res.json({ ajoutes: r.nouveaux.length, doublonsIgnores: r.doublons, erreurs: r.erreurs });
});
app.post("/api/:id/transport/exemple", protegerAcces, (req, res) => {
  const entry = entreeTransport(req, res); if (!entry) return;
  const r = entry.engine.chargerExemple();
  if (r.erreur === "dejaRempli") return res.status(409).json({ erreur: r.message, code: r.erreur });
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  res.status(201).json({ lignes: r.lignes.length, departs: r.departs.length });
});

// -- Parametres : commun aux deux types (autoConfirmMessage, + horaires/dureeCreneauMinutes pour service) --
// (permission employe requise : "parametres")

app.get("/api/:id/parametres", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  res.json(entry.engine.getSettings());
});

app.put("/api/:id/parametres", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  let corps = req.body || {};
  if (corps.fuseau !== undefined && !sh.fuseauValide(corps.fuseau)) {
    return res.status(400).json({ erreur: "Fuseau horaire invalide (exemple : Africa/Douala)." });
  }
  // Meme principe de filtrage cote serveur que stockIllimite (PUT /api/:id/catalogue) et
  // numero-whatsapp-public ci-dessous : un marchand ne peut pas regler ses notifications de statut par
  // appel API direct tant que le super-administrateur n'a pas debloque l'option pour lui, meme si
  // l'interface /admin ne montre jamais ce bloc dans ce cas.
  if (!entry.merchant.optionNotificationsStatut && corps.notifStatut !== undefined) {
    corps = Object.assign({}, corps);
    delete corps.notifStatut;
  }
  // Meme principe de filtrage : les reglages de caisse (seuil d'ecart/coupures/mode session) ne peuvent
  // pas etre modifies par appel API direct tant que le super-administrateur n'a pas debloque l'option
  // "Caisse POS" pour ce marchand, meme si l'interface /admin ne montre jamais ce bloc dans ce cas.
  if (!entry.merchant.optionCaissePos && corps.caisse !== undefined) {
    corps = Object.assign({}, corps);
    delete corps.caisse;
  }
  res.json(entry.engine.updateSettings(corps));
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

// Etape 76 : numeros d'alerte SUPPLEMENTAIRES (option payante). Le quota est fixe par le seul super-administrateur
// (PUT /api/marchands/:id/options-payantes) ; ici, le marchand (ou le super-administrateur) remplit la liste dans cette limite.
// Quota a 0 : refuse pour tout le monde (le super-administrateur doit d'abord ouvrir l'option). Tous ces numeros recoivent
// les memes alertes que le numero principal (commande, conseiller humain, rendez-vous, sejour...).
app.put("/api/:id/numeros-notification", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  const quota = quotaNumerosSupp(entry.merchant);
  if (quota < 1) return res.status(403).json({ erreur: "Cette option n'est pas activée pour ce marchand." });
  const brut = (req.body || {}).numeros;
  if (!Array.isArray(brut)) return res.status(400).json({ erreur: "numeros doit être une liste de numéros." });
  const propres = []; const vus = new Set(chiffresTel(entry.merchant.phoneNotification) ? [chiffresTel(entry.merchant.phoneNotification)] : []);
  for (let i = 0; i < brut.length; i++) {
    const texte = String(brut[i] == null ? "" : brut[i]).trim();
    if (!texte) continue;
    const c = chiffresTel(texte);
    if (c.length < 8 || c.length > 15 || /[^\d\s+().-]/.test(texte)) return res.status(400).json({ erreur: "Numéro invalide : « " + texte.slice(0, 30) + " » (8 à 15 chiffres, avec l'indicatif du pays, ex. 237670000000)." });
    if (vus.has(c)) return res.status(400).json({ erreur: "Numéro en double (ou identique au numéro principal) : « " + texte.slice(0, 30) + " »." });
    vus.add(c); propres.push(c);
  }
  if (propres.length > quota) return res.status(400).json({ erreur: "Ce marchand peut avoir " + quota + " numéro(s) supplémentaire(s) au maximum." });
  const maj = await db.updateMerchantFields(req.params.id, { numerosNotificationSupp: propres });
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.numerosNotificationSupp = maj.numerosNotificationSupp;
  res.json({ id: req.params.id, numeros: maj.numerosNotificationSupp, quota });
});

// -- Numero WhatsApp "public" du marchand (celui que ses clients contactent reellement) : sert UNIQUEMENT
// a generer les liens de commande wa.me par article (bouton "Copier le lien" dans /admin > Catalogue,
// demande le 15 septembre 2026 pour les marchands qui postent leurs articles dans des groupes WhatsApp et
// veulent rediriger les clients interesses vers une conversation directe avec le bot plutot que de leur
// repondre manuellement). N'a AUCUN effet sur l'envoi/reception reels de messages (ca reste phone_number_id
// + WHATSAPP_TOKEN cote Meta) - c'est juste le numero affiche dans le lien. Memes regles de portee que
// /notification ci-dessus. --
app.put("/api/:id/numero-whatsapp-public", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  // Etape 42 : plus reserve a l'option "Lien de commande" - le numero sert aussi au QR code WhatsApp (ouvert a tous
  // les marchands). L'option continue de gouverner uniquement les boutons "Copier le lien" par article.
  const { numeroWhatsappPublic } = req.body || {};
  const maj = await db.updateMerchantFields(req.params.id, { numeroWhatsappPublic: numeroWhatsappPublic || null });
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.numeroWhatsappPublic = maj.numeroWhatsappPublic;
  res.json({ id: req.params.id, numeroWhatsappPublic: maj.numeroWhatsappPublic });
});

// -- Filigrane du logo /admin (29 septembre 2026) : le marchand peut desactiver l'affichage de son logo en
// filigrane dans la zone de contenu (voir appliquerFiligraneLogo() dans admin.html), par exemple si son
// logo a un fond plein qui rend mal en transparence. Actif par defaut des qu'un logo existe (voir
// filigrane_logo_actif dans db.js), donc cette route ne sert qu'a le DESACTIVER explicitement (ou le
// reactiver ensuite) - jamais a fournir le logo lui-meme (voir POST/DELETE /api/marchands/:id/logo pour
// ca). Memes regles de portee/permission que /notification et /numero-whatsapp-public ci-dessus. --
app.put("/api/:id/filigrane-logo", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  const { filigraneLogoActif } = req.body || {};
  const maj = await db.updateMerchantFields(req.params.id, { filigraneLogoActif: !!filigraneLogoActif });
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.filigraneLogoActif = maj.filigraneLogoActif;
  res.json({ id: req.params.id, filigraneLogoActif: maj.filigraneLogoActif });
});

// -- Diagnostic "Tester l'alerte maintenant" -------------------------------------------------------
// Demande apres un cas reel ou un marchand ne recevait ni alerte "commande" ni alerte "humain" alors
// que ses templates WhatsApp etaient pourtant actifs cote Meta : le probleme se situe presque toujours
// dans la configuration (numero de notification absent/mal forme, template approuve sous un AUTRE
// compte WhatsApp Business que celui reellement branche sur Render, jeton expire...), jamais visible
// depuis les seuls logs serveur que le marchand n'a pas l'habitude de consulter. Cette route envoie une
// VRAIE alerte de test (template "izyvendeur_alerte_humain", memes parametres qu'une vraie demande
// humaine) au numero de notification configure, et renvoie le detail BRUT de la reponse WhatsApp
// (reussite ou erreur exacte de Meta) directement affichable dans /admin - voir les fonctions
// envoyerTemplateWhatsAppDiag/envoyerMessageWhatsAppDiag ci-dessous (variantes des fonctions d'envoi
// habituelles qui, contrairement a elles, remontent le detail au lieu de se contenter de logguer).
app.post("/api/marchands/:id/tester-alerte", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  // Etape 76 : `numero` (facultatif) teste l'un des numeros supplementaires autorises ; sans lui, le numero principal.
  const numeroDemande = req.body && req.body.numero ? String(req.body.numero) : null;
  const destinataire = numeroDemande
    ? numerosAlerteDe(entry.merchant).filter((n) => chiffresTel(n) === chiffresTel(numeroDemande))[0] || null
    : entry.merchant.phoneNotification;
  if (numeroDemande && !destinataire) {
    return res.status(400).json({ erreur: "Ce numéro ne fait pas partie des numéros d'alerte de ce marchand." });
  }
  if (!destinataire) {
    return res.status(400).json({ erreur: "Configurez d'abord un numéro de notification ci-dessus avant de tester l'alerte." });
  }
  const phoneNumberId = entry.merchant.phoneNumberId;
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    return res.status(503).json({ erreur: "WHATSAPP_TOKEN ou le numéro WhatsApp business de ce marchand n'est pas configuré sur le serveur." });
  }

  const config = TEMPLATES_ALERTE_MARCHAND.humain;
  const paramsTest = [
    "N/A (test)",
    "Ceci est une alerte de TEST envoyée depuis /admin (bouton \"Tester l'alerte\") — aucune action requise.",
  ];

  const resultatTemplate = await envoyerTemplateWhatsAppDiag(destinataire, phoneNumberId, config.nom, config.langue, paramsTest, config.parametresNoms);
  if (resultatTemplate.ok) {
    return res.json({ ok: true, canal: "template", destinataire, nomTemplate: config.nom });
  }

  // Le template a echoue : on tente le repli texte libre (fonctionne seulement si `destinataire` a deja
  // ecrit au numero WhatsApp business de ce marchand dans les 24h) - un succes ici, alors que le template
  // a echoue, pointe precisement vers un souci de TEMPLATE (nom incorrect, pas approuve, ou approuve sous
  // un compte WhatsApp Business different de celui reellement utilise) plutot que vers le numero ou le
  // jeton, qui eux fonctionnent visiblement.
  const resultatTexteLibre = await envoyerMessageWhatsAppDiag(destinataire, config.texteLibreRepli(paramsTest), phoneNumberId);

  res.json({
    ok: resultatTexteLibre.ok,
    canal: resultatTexteLibre.ok ? "texte_libre" : "aucun",
    destinataire,
    nomTemplate: config.nom,
    detailTemplate: { statusHttp: resultatTemplate.status, erreur: resultatTemplate.erreur },
    detailTexteLibre: { statusHttp: resultatTexteLibre.status, erreur: resultatTexteLibre.erreur },
  });
});

// -- Logo du marchand : affiche UNIQUEMENT dans /admin (en-tete) - identite de marque stable. Voir plus
// bas /image-accueil-whatsapp pour l'image envoyee cote client WhatsApp : deux reglages VOLONTAIREMENT
// separes (aucun repli de l'un vers l'autre) pour qu'un marchand puisse changer librement son image
// d'accueil WhatsApp (flyer de promo, offre du moment...) sans jamais toucher a son logo officiel, et
// inversement. Memes regles de portee que /notification ci-dessus (super-administrateur pour n'importe
// qui, marchand pour lui-meme) — ce sont des reglages cosmetiques/de marque, pas des champs structurants
// comme "nom"/"phone_number_id" (voir /infos plus haut, reserve au super-administrateur car changer
// ces deux-la peut casser le routage ou la lecture de l'etat existant). Une seule image a la fois pour
// chacun : l'ancienne est supprimee du bucket R2 apres un upload reussi. --

app.post("/api/marchands/:id/logo", protegerAcces, uploadPhoto.single("logo"), async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (!storage.estConfigure()) {
    return res.status(503).json({ erreur: "Hébergement des images non configuré sur le serveur (variables R2_* manquantes sur Render)." });
  }
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"logo\" requis)." });
  try {
    const ancienUrl = entry.merchant.logoUrl || null;
    const url = await storage.uploaderLogoMarchand({
      merchantKey: req.params.id,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });
    const maj = await db.updateMerchantFields(req.params.id, { logoUrl: url });
    if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
    entry.merchant.logoUrl = maj.logoUrl;
    if (ancienUrl) await storage.supprimerPhotoProduit(ancienUrl); // best-effort, remplace l'ancien logo
    res.status(201).json({ id: req.params.id, logoUrl: maj.logoUrl });
  } catch (erreur) {
    res.status(400).json({ erreur: erreur.message || "Échec de l'envoi du logo." });
  }
});

app.delete("/api/marchands/:id/logo", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (!estGestionnaireDuMarchand(req, req.params.id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  const ancienUrl = entry.merchant.logoUrl || null;
  const maj = await db.updateMerchantFields(req.params.id, { logoUrl: null });
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.logoUrl = null;
  if (ancienUrl) await storage.supprimerPhotoProduit(ancienUrl); // best-effort
  res.json({ ok: true });
});

// Etape 43 (correctif) : relais du logo du marchand vers /admin, UNIQUEMENT pour dessiner le QR code avec son
// logo au centre. Le logo est heberge sur Cloudflare R2 (autre origine, sans en-tete CORS) : le navigateur
// sait l'AFFICHER dans une balise <img>, mais interdit de le recopier dans un canvas (necessaire pour fabriquer
// le PNG/PDF du QR). Ce relais le re-sert depuis la meme origine que /admin. Aucun parametre n'est
// accepte : l'URL relayee est TOUJOURS celle enregistree en base pour ce marchand (jamais fournie par le
// client, donc pas de relais ouvert vers n'importe quelle adresse). Memes regles de portee que le reste : un
// marchand ne lit que son propre logo, le superadmin celui de n'importe qui. Lecture seule, aucun effet de bord.
app.get("/api/marchands/:id/logo-image", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res); if (!entry) return;
  const url = entry.merchant.logoUrl || null;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(404).json({ erreur: "Aucun logo." });
  try {
    const reponse = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!reponse.ok) return res.status(502).json({ erreur: "Logo inaccessible." });
    const type = (reponse.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|webp)$/.test(type)) return res.status(502).json({ erreur: "Le fichier du logo n'est pas une image." });
    const donnees = Buffer.from(await reponse.arrayBuffer());
    if (donnees.length > 5 * 1024 * 1024) return res.status(502).json({ erreur: "Logo trop volumineux." });
    res.set({ "Content-Type": type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" });
    res.send(donnees);
  } catch (e) {
    res.status(502).json({ erreur: "Logo inaccessible." });
  }
});

app.post("/api/marchands/:id/image-accueil-whatsapp", protegerAcces, uploadPhoto.single("image"), async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (!storage.estConfigure()) {
    return res.status(503).json({ erreur: "Hébergement des images non configuré sur le serveur (variables R2_* manquantes sur Render)." });
  }
  if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu (champ \"image\" requis)." });
  try {
    const ancienUrl = entry.merchant.imageAccueilWhatsappUrl || null;
    const url = await storage.uploaderImageAccueilWhatsapp({
      merchantKey: req.params.id,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });
    const maj = await db.updateMerchantFields(req.params.id, { imageAccueilWhatsappUrl: url });
    if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
    entry.merchant.imageAccueilWhatsappUrl = maj.imageAccueilWhatsappUrl;
    if (ancienUrl) await storage.supprimerPhotoProduit(ancienUrl); // best-effort, remplace l'ancienne image
    res.status(201).json({ id: req.params.id, imageAccueilWhatsappUrl: maj.imageAccueilWhatsappUrl });
  } catch (erreur) {
    res.status(400).json({ erreur: erreur.message || "Échec de l'envoi de l'image." });
  }
});

app.delete("/api/marchands/:id/image-accueil-whatsapp", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "parametres"); if (!entry) return;
  if (!estGestionnaireDuMarchand(req, req.params.id)) return res.status(403).json({ erreur: "Réservé au propriétaire du marchand." });
  const ancienUrl = entry.merchant.imageAccueilWhatsappUrl || null;
  const maj = await db.updateMerchantFields(req.params.id, { imageAccueilWhatsappUrl: null });
  if (!maj) return res.status(404).json({ erreur: "Marchand introuvable." });
  entry.merchant.imageAccueilWhatsappUrl = null;
  if (ancienUrl) await storage.supprimerPhotoProduit(ancienUrl); // best-effort
  res.json({ ok: true });
});

// -- Mise en relation avec un humain : conversations actuellement en pause, et reponse manuelle du
// marchand (envoyee au client via le meme compte WhatsApp que le bot). Permission employe requise :
// "conversations". --

app.get("/api/:id/conversations", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "conversations"); if (!entry) return;
  // Marchand hybride : les conversations en pause des DEUX volets, dans une seule liste.
  const listes = Object.keys(entry.moteurs).map((t) => entry.moteurs[t].getConversationsEnAttente().map((c) => Object.assign({}, c, { volet: t })));
  res.json([].concat(...listes));
});

app.post("/api/:id/conversations/:telephone/repondre", protegerAcces, async (req, res) => {
  const entry = getMarchandAutorise(req, res, "conversations"); if (!entry) return;
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ erreur: "message requis." });
  let ok = false;
  for (const t of Object.keys(entry.moteurs)) {
    ok = await entry.moteurs[t].repondreConversationHumain(req.params.telephone, String(message));
    if (ok) break;
  }
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
// "tableaudebord", independante de "parametres" depuis le 25 septembre 2026 (voir ROLES_EMPLOYE_VALIDES). --

app.get("/api/:id/tableau-de-bord", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "tableaudebord"); if (!entry) return;
  const { periode, date } = req.query || {};
  res.json(entry.engine.getTableauDeBord({
    periode: periode ? String(periode) : "jour",
    dateReference: date ? new Date(String(date)) : new Date(),
  }));
});

// -- Simulateur WhatsApp : permet au marchand de tester le bot depuis l'interface admin,
// sans jamais toucher aux vraies conversations/commandes/rendez-vous des clients (voir
// PHONE_SIMULATEUR dans conversation.js / conversationService.js). Accessible a un employe ayant le role
// operationnel de ce type de marchand ("catalogue" ou "rendezvous") OU le role "conversations" (tester le
// parcours bot fait aussi partie du service client). --

const PHONE_SIMULATEUR_HYBRIDE = "SIMULATEUR"; // meme numero reserve que PHONE_SIMULATEUR des deux moteurs

// Un employe ne teste le parcours COMPLET d'un marchand hybride (qui montre les deux volets) que s'il a le
// role « conversations » ou le role operationnel de CHACUN des volets ; sinon il utilise `?volet=`.
function simulateurHybrideAutorise(req, entry) {
  if (req.auth.role !== "employe") return true;
  const roles = req.auth.roles || [];
  if (roles.indexOf("conversations") !== -1) return true;
  return Object.keys(entry.moteurs).every((t) => roles.indexOf(permissionDuVolet(t)) !== -1);
}

function simulerHybride(entry, message) {
  const d = entry.routeur.traiter(PHONE_SIMULATEUR_HYBRIDE, message);
  if (d.type === "menu") return { reponse: d.texte, trace: null, volet: null, boutons: d.boutons.map((b) => ({ volet: b.volet, title: b.title })) };
  let r;
  if (d.type === "reprise") r = { reponse: d.reponse, trace: null };
  else r = compacterReponseSimulateur(entry.moteurs[d.volet], entry.moteurs[d.volet].handleMessageSimulateur(d.texte, d.sansJournalClient ? { sansJournalClient: true } : undefined));
  if (r.reponse && d.suffixe) r.reponse += d.suffixe;
  return Object.assign({}, r, { volet: d.volet });
}

// Etape 51 (13 oct 2026) : le Simulateur affichait le texte BRUT du moteur, donc encore la longue liste de
// tous les articles, alors que le vrai WhatsApp la remplace desormais par le message d'accueil du marchand
// (Etape 50, compacterTexteMenuCatalogue). On applique ici la MEME regle, dans les MEMES conditions que
// le vrai envoi (etape "idle" + pret pour un choix), pour que le marchand voie ce que voit son client et
// puisse l'aider. Les boutons/listes cliquables, eux, ne sont toujours pas simules.
function compacterReponseSimulateur(moteur, resultat) {
  try {
    if (resultat && resultat.reponse && moteur && moteur.type === "transport" && typeof moteur.getEtatSession === "function") {
      // Etape 74 : le Simulateur ne montre pas les listes cliquables : on ajoute les options en texte numerote.
      const opts = texteOptionsTransport(moteur.getEtatSession("SIMULATEUR"));
      return opts ? Object.assign({}, resultat, { reponse: resultat.reponse + "\n\n" + opts }) : resultat;
    }
    if (!resultat || !resultat.reponse || !moteur || moteur.type !== "catalogue" || typeof moteur.getEtatSession !== "function") return resultat;
    const etat = moteur.getEtatSession("SIMULATEUR"); // numero reserve, voir PHONE_SIMULATEUR dans conversation.js
    if (!etat || etat.stage !== "idle" || !etat.pretPourChoix) return resultat;
    return Object.assign({}, resultat, { reponse: compacterTexteMenuCatalogue({ engine: moteur }, resultat.reponse, etat) });
  } catch (e) {
    return resultat;
  }
}

app.post("/api/:id/simulateur/message", protegerAcces, (req, res) => {
  const merchantExistant = engines[req.params.id];
  // Marchand hybride : le role operationnel de CHACUN de ses volets ouvre le Simulateur (volet choisi par `?volet=`).
  const permissionsOperationnelles = merchantExistant
    ? Object.keys(merchantExistant.moteurs).map(permissionDuVolet)
    : ["catalogue"];
  const modeRouteur = !!(merchantExistant && estHybride(merchantExistant) && !(req.query && req.query.volet));
  const entry = getMarchandAutorise(req, res, permissionsOperationnelles.concat("conversations")); if (!entry) return;
  if (modeRouteur && !simulateurHybrideAutorise(req, merchantExistant)) return res.status(403).json({ erreur: "Vous n'avez pas accès à cette fonctionnalité." });
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ erreur: "message requis." });
  // Marchand hybride SANS `?volet=` : le Simulateur passe par le MEME routeur que le vrai WhatsApp (porte de
  // langue, menu a deux boutons, paniers separes). Avec `?volet=`, il teste directement ce volet.
  if (modeRouteur) return res.json(simulerHybride(merchantExistant, String(message)));
  res.json(compacterReponseSimulateur(entry.engine, entry.engine.handleMessageSimulateur(String(message))));
});

app.post("/api/:id/simulateur/reset", protegerAcces, (req, res) => {
  const merchantExistant = engines[req.params.id];
  // Marchand hybride : le role operationnel de CHACUN de ses volets ouvre le Simulateur (volet choisi par `?volet=`).
  const permissionsOperationnelles = merchantExistant
    ? Object.keys(merchantExistant.moteurs).map(permissionDuVolet)
    : ["catalogue"];
  const modeRouteur = !!(merchantExistant && estHybride(merchantExistant) && !(req.query && req.query.volet));
  const entry = getMarchandAutorise(req, res, permissionsOperationnelles.concat("conversations")); if (!entry) return;
  if (modeRouteur) {
    if (!simulateurHybrideAutorise(req, merchantExistant)) return res.status(403).json({ erreur: "Vous n'avez pas accès à cette fonctionnalité." });
    Object.keys(merchantExistant.moteurs).forEach((t) => merchantExistant.moteurs[t].resetSimulateur());
    merchantExistant.routeur.oublier(PHONE_SIMULATEUR_HYBRIDE);
    return res.json({ ok: true });
  }
  entry.engine.resetSimulateur();
  res.json({ ok: true });
});

// -- Rapports : reserve aux marchands de type catalogue. Permission employe requise : "rapports" -
// independante de "tableaudebord" ET desormais de "inventaire" (deux droits distincts depuis le 25
// septembre 2026, alors qu'ils vivaient ensemble dans un seul onglet "Rapports" jusque-la). --

app.get("/api/:id/rapports/commandes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "rapports"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { periode, date, articleId } = req.query || {};
  const dateReference = date ? new Date(String(date)) : new Date();
  res.json(entry.engine.getRapportCommandes({
    periode: periode ? String(periode) : "jour",
    dateReference,
    articleId: articleId ? String(articleId) : null,
  }));
});

// -- Inventaire : reserve aux marchands de type catalogue. Permission employe requise : "inventaire",
// independante de "rapports" depuis le 25 septembre 2026 (meme journee que sa creation). --

app.get("/api/:id/inventaire/actuel", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "inventaire"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.getInventaireActuel());
});

app.get("/api/:id/inventaire/instantanes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "inventaire"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.listerInstantanesInventaire());
});

app.post("/api/:id/inventaire/instantanes", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "inventaire"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { nom } = req.body || {};
  res.status(201).json(entry.engine.enregistrerInstantaneInventaire(nom && String(nom).trim() ? String(nom).trim() : "Instantané"));
});

// Suppression d'un instantané d'inventaire, RESERVEE AU PROPRIETAIRE DU MARCHAND (ou super-administrateur) -
// depuis le 25 septembre 2026, un employé ayant le rôle "inventaire" peut consulter/créer des instantanés
// mais ne voit plus le bouton Supprimer (voir estGestionnaireDuMarchand ci-dessus, meme principe que pour
// la gestion des employés). La suppression elle-même est "en douceur" : voir supprimerInstantaneInventaire
// dans conversation.js - l'instantané reste consultable ensuite, marqué "Supprimé le ... par ...".
app.delete("/api/:id/inventaire/instantanes/:snapshotId", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "inventaire"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!estGestionnaireDuMarchand(req, req.params.id)) {
    return res.status(403).json({ erreur: "La suppression d'un instantané est réservée au propriétaire du marchand." });
  }
  const ok = entry.engine.supprimerInstantaneInventaire(req.params.snapshotId, req.auth.adminUser || null);
  if (!ok) return res.status(404).json({ erreur: "Instantané introuvable ou déjà supprimé." });
  res.json({ ok: true });
});

// -- Liste d'attente de reassort (octobre 2026) -- clients ayant demande a etre prevenus quand un article en
// rupture revient en stock (voir conversation.js, enregistrerAttenteReassort). Permission "catalogue" : c'est
// de la gestion de stock. Le marchand contacte lui-meme ces clients puis marque l'entree "contactee".
app.get("/api/:id/liste-attente", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "catalogue"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.listerAttenteReassort());
});

app.post("/api/:id/liste-attente/:entreeId/contacte", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "catalogue"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const ok = entry.engine.marquerAttenteReassortContactee(req.params.entreeId, req.auth.adminUser || null);
  if (!ok) return res.status(404).json({ erreur: "Entrée introuvable ou déjà marquée comme contactée." });
  res.json({ ok: true });
});

// -- Etape 73 : « A relancer » (tableau de bord) -- paniers abandonnes et commandes restees « Nouvelle ». Permission « commandes ».
// Le marchand relance depuis son propre WhatsApp (lien wa.me construit dans /admin) : rien n'est envoye par le bot.
app.get("/api/:id/a-relancer", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "commandes"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  res.json(entry.engine.aRelancer());
});
app.put("/api/:id/a-relancer/delai", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "commandes"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  if (!entry.engine.definirDelaiRelanceHeures((req.body || {}).heures)) return res.status(400).json({ erreur: "Délai invalide (2, 6, 12, 24, 48 ou 72 heures)." });
  res.json(entry.engine.aRelancer());
});
app.post("/api/:id/a-relancer/marquer", protegerAcces, (req, res) => {
  const entry = getMarchandAutorise(req, res, "commandes"); if (!entry) return;
  if (entry.engine.type !== "catalogue") return res.status(400).json({ erreur: "Ce marchand n'est pas de type catalogue." });
  const { type, cle } = req.body || {};
  if (!entry.engine.marquerRelance(String(type || ""), String(cle || ""), req.auth.adminUser || null)) return res.status(404).json({ erreur: "Élément introuvable ou déjà traité." });
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
  // Rejette AVANT tout traitement (et avant meme l'accuse de reception habituel ci-dessous) une requete dont
  // la signature Meta ne correspond pas - voir verifierSignatureWebhook() plus haut. Si WHATSAPP_APP_SECRET
  // n'est pas configuree, cette fonction renvoie toujours true (comportement inchange).
  if (!verifierSignatureWebhook(req)) {
    console.warn("[securite webhook] Signature X-Hub-Signature-256 invalide ou absente - requete rejetee.");
    res.sendStatus(403);
    return;
  }

  // On repond tout de suite 200 a Meta pour accuser reception (sinon Meta reessaie / se plaint).
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const statuses = value?.statuses;
    const phoneNumberId = value?.metadata?.phone_number_id;

    // Etape 25 (27 sept 2026) : Meta signale la livraison REELLE (ou l'echec) d'un message deja envoye via
    // un evenement SEPARE "statuses" sur ce meme webhook - jamais via la reponse HTTP synchrone du POST
    // d'envoi, qui ne confirme que l'ACCEPTATION du message par Meta (mise en file), pas son arrivee reelle
    // sur le telephone. Avant cette etape, ces evenements etaient purement ignores (voir l'ancien
    // commentaire ici, qui disait litteralement "rien a faire") - ce qui rendait un "Reussi" du bouton
    // "Tester l'alerte maintenant" totalement aveugle a un echec de livraison survenant juste apres (cause
    // reelle d'un souci de notification signale par un marchand malgre un test "reussi").
    if (statuses && statuses.length) {
      const merchantIdStatut = phoneNumberId && phoneNumberIndex[phoneNumberId];
      const marchandStatut = merchantIdStatut && engines[merchantIdStatut];
      for (const s of statuses) {
        if (s.status !== "failed") continue; // "sent"/"delivered"/"read" : rien a signaler, seul l'echec importe ici
        const erreur = (s.errors && s.errors[0]) || {};
        const detail = {
          horodatage: new Date().toISOString(),
          destinataire: s.recipient_id || null,
          wamid: s.id || null,
          code: erreur.code != null ? erreur.code : null,
          titre: erreur.title || null,
          message: erreur.message || (erreur.error_data && erreur.error_data.details) || null
        };
        console.error(`[${merchantIdStatut || phoneNumberId || "?"}] Echec de livraison WhatsApp signale par Meta (statuses) :`, JSON.stringify(detail));
        // Rapproche du numero de NOTIFICATION du marchand (celui qui recoit les alertes) - comparaison sur
        // les seuls chiffres pour tolerer les differences de format ("+237..." vs "237..."). Si ca
        // correspond, on enregistre ce detail pour l'afficher directement dans /admin a cote de "Tester
        // l'alerte maintenant" (voir GET /api/marchands) - sans ca, un marchand n'a aucun moyen de savoir
        // POURQUOI une VRAIE alerte echoue, contrairement au bouton de test qui lui montre deja le detail
        // d'un echec immediat (mais jamais d'un echec survenant apres coup, cote livraison).
        if (marchandStatut && numerosAlerteDe(marchandStatut.merchant).length) {
          const chiffres = (txt) => String(txt || "").replace(/\D/g, "");
          if (numerosAlerteDe(marchandStatut.merchant).some((n) => chiffres(n) === chiffres(detail.destinataire))) {
            db.updateMerchantFields(merchantIdStatut, { derniereErreurAlerte: detail })
              .then((maj) => { if (maj) marchandStatut.merchant.derniereErreurAlerte = maj.derniereErreurAlerte; })
              .catch((err) => console.error(`[${merchantIdStatut}] Echec d'enregistrement de la derniere erreur d'alerte :`, err));
          }
        }
      }
    }

    if (!messages || messages.length === 0) {
      // Ce n'est pas un nouveau message entrant (ex: seulement une mise a jour de statut, deja traitee
      // juste au-dessus) -> rien d'autre a faire.
      return;
    }

    const merchantId = phoneNumberId && phoneNumberIndex[phoneNumberId];
    let marchand = merchantId && engines[merchantId];
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

    // Marchand HYBRIDE (Etape 47) : tout le reste du traitement (pagination, categories, menus cliquables,
    // moteur de conversation) s'applique au volet ou se trouve DEJA ce client ; le routeur peut ensuite le
    // faire changer de volet pour ce message (voir plus bas). `entreeComplete` garde l'acces aux deux moteurs.
    const entreeComplete = marchand;
    if (estHybride(entreeComplete)) marchand = vueEntree(entreeComplete, entreeComplete.routeur.voletActif(from));

    // Clic sur "Voir plus d'articles/services ▸" (pagination d'un catalogue/service trop fourni pour
    // tenir sur une seule liste WhatsApp - 10 lignes max au total) : pure navigation d'affichage, ne
    // correspond a AUCUN texte que le client aurait pu taper et ne doit donc jamais passer par
    // engine.handleMessage() (qui changerait l'etat de la conversation). On envoie juste la page suivante.
    let idInteractifClique = message.type === "interactive"
      ? (message.interactive?.list_reply?.id || message.interactive?.button_reply?.id || "")
      : "";
    // Etape 70 : « Mon panier / Mon rendez-vous / Ma reservation » touche dans le MENU PRINCIPAL d'un marchand hybride : on conduit
    // le client dans ce volet puis on rejoue le clic habituel (panier, ou boutons Annuler / Reporter) comme s'il venait de la liste du volet.
    if (estHybride(entreeComplete) && idInteractifClique.indexOf(PREFIXE_ESPACE) === 0) {
      const quoi = idInteractifClique.slice(PREFIXE_ESPACE.length);
      const voletCible = quoi === "panier" || quoi === "commande" ? "catalogue" : quoi === "rdv" ? "service" : quoi === "sejour" ? "hebergement" : quoi === "billets" ? "transport" : null;
      if (voletCible && entreeComplete.moteurs[voletCible]) {
        if (quoi === "panier" || quoi === "commande") {
          const eCat = entreeComplete.moteurs.catalogue.getEtatSession(from);
          const stadesOk = quoi === "commande" ? STADES_ACCES_COMMANDE : ["idle", "awaiting_quantity", "awaiting_more_items", "viewing_cart"];
          const peutVoir = !eCat || stadesOk.indexOf(eCat.stage) !== -1;
          // Commande deja avancee (telephone, adresse...) : on redonne sa derniere question au lieu d'afficher le panier.
          entreeComplete.routeur.entrerDansVolet(from, "catalogue", !peutVoir);
          idInteractifClique = peutVoir ? (quoi === "commande" ? ID_MA_COMMANDE : ID_PANIER) : ID_VOLET_CATALOGUE;
        } else if (quoi === "billets") {
          entreeComplete.routeur.entrerDansVolet(from, "transport", false);
          idInteractifClique = ID_MES_BILLETS;
        } else {
          entreeComplete.routeur.entrerDansVolet(from, voletCible, false);
          idInteractifClique = ID_MON_RDV;
        }
        marchand = vueEntree(entreeComplete, voletCible);
      }
    }

    if (idInteractifClique.indexOf(PREFIXE_VOIR_PLUS) === 0) {
      const offset = Number(idInteractifClique.slice(PREFIXE_VOIR_PLUS.length)) || 0;
      const estCatalogue = marchand.engine.type === "catalogue";
      const items = construireItemsListe(marchand);
      const etatPourLangue = typeof marchand.engine.getEtatSession === "function" ? marchand.engine.getEtatSession(from) : null;
      const rows = construireLignesListe(items, offset, etatPourLangue, ligneMenuPrincipal(marchand, etatPourLangue), undefined, estCatalogue ? lignesMonPanier(marchand, etatPourLangue) : lignesMonRendezVous(marchand, from, etatPourLangue));
      const lib = libellesListeAccueil(marchand, etatPourLangue);
      const texteCorps = lib.suite;
      db.logConversationMessage(merchantId, from, "client", lib.journal).catch(() => {});
      const envoye = await envoyerListeWhatsApp(
        from, phoneNumberId, texteCorps, lib.bouton,
        [{ title: lib.section, rows }]
      ).catch(() => false);
      if (envoye) db.logConversationMessage(merchantId, from, "bot", texteCorps).catch(() => {});
      else await envoyerMessageWhatsApp(from, texteCorps + "\n" + items.slice(offset).map((it) => "• " + it.nom).join("\n"), phoneNumberId);
      return;
    }

    // Etape 24 - Navigation par categorie : ces 4 blocs sont, comme celui de PREFIXE_VOIR_PLUS ci-dessus,
    // de la pure navigation/affichage interceptee AVANT engine.handleMessage() - aucun n'affecte l'etat de
    // la conversation, ils ne font que rebatir et renvoyer un ecran different (categories, ou articles d'une
    // categorie, avec leur propre pagination et retour).
    const etatPourCategories = typeof marchand.engine.getEtatSession === "function" ? marchand.engine.getEtatSession(from) : null;

    if (idInteractifClique.indexOf(PREFIXE_VOIR_PLUS_CATEGORIES) === 0) {
      const offset = Number(idInteractifClique.slice(PREFIXE_VOIR_PLUS_CATEGORIES.length)) || 0;
      const texteCorps = tW(etatPourCategories, "Voici la suite de nos catégories :", "Here are more of our categories:");
      db.logConversationMessage(merchantId, from, "client", "Voir plus de catégories").catch(() => {});
      const envoye = await envoyerEcranCategories(from, phoneNumberId, marchand, offset, texteCorps, etatPourCategories).catch(() => false);
      if (envoye) db.logConversationMessage(merchantId, from, "bot", texteCorps).catch(() => {});
      return;
    }

    if (idInteractifClique === ID_RETOUR_CATEGORIES) {
      const texteCorps = tW(etatPourCategories, "Voici nos catégories :", "Here are our categories:");
      db.logConversationMessage(merchantId, from, "client", "Retour aux catégories").catch(() => {});
      const envoye = await envoyerEcranCategories(from, phoneNumberId, marchand, 0, texteCorps, etatPourCategories).catch(() => false);
      if (envoye) db.logConversationMessage(merchantId, from, "bot", texteCorps).catch(() => {});
      return;
    }

    if (idInteractifClique.indexOf(PREFIXE_CATEGORIE) === 0) {
      const catIndex = Number(idInteractifClique.slice(PREFIXE_CATEGORIE.length));
      const categories = construireCategoriesCatalogue(marchand);
      const nomCategorie = categories[catIndex];
      const texteCorps = tW(etatPourCategories, "Voici nos articles :", "Here are our items:");
      db.logConversationMessage(merchantId, from, "client", "Catégorie : " + (nomCategorie || "?")).catch(() => {});
      const envoye = await envoyerEcranArticlesCategorie(from, phoneNumberId, marchand, catIndex, 0, texteCorps, etatPourCategories).catch(() => false);
      if (envoye) db.logConversationMessage(merchantId, from, "bot", texteCorps).catch(() => {});
      return;
    }

    if (idInteractifClique.indexOf(PREFIXE_VOIR_PLUS_DANS_CAT) === 0) {
      const reste = idInteractifClique.slice(PREFIXE_VOIR_PLUS_DANS_CAT.length);
      const sep = reste.indexOf("_");
      const catIndex = Number(sep === -1 ? reste : reste.slice(0, sep));
      const offset = Number(sep === -1 ? 0 : reste.slice(sep + 1)) || 0;
      const texteCorps = tW(etatPourCategories, "Voici la suite de nos articles :", "Here are more of our items:");
      db.logConversationMessage(merchantId, from, "client", "Voir plus d'articles (catégorie)").catch(() => {});
      const envoye = await envoyerEcranArticlesCategorie(from, phoneNumberId, marchand, catIndex, offset, texteCorps, etatPourCategories).catch(() => false);
      if (envoye) db.logConversationMessage(merchantId, from, "bot", texteCorps).catch(() => {});
      return;
    }

    // Etape 63 - clic sur « Mon rendez-vous » : pure navigation (aucun changement d'etat de la conversation) ; on
    // propose Annuler / Reporter / Contacter un conseiller. Le clic sur l'un de ces boutons passe ensuite par le
    // moteur comme si la cliente avait ecrit « annuler mon rendez-vous » / « reporter mon rendez-vous ».
    if (idInteractifClique === ID_MON_RDV && (marchand.engine.type === "service" || marchand.engine.type === "hebergement")) {
      const etatPourLangue = typeof marchand.engine.getEtatSession === "function" ? marchand.engine.getEtatSession(from) : null;
      const heb = marchand.engine.type === "hebergement";
      const question = heb ? tW(etatPourLangue, "Que souhaitez-vous faire de votre réservation ?", "What would you like to do with your booking?") : tW(etatPourLangue, "Que souhaitez-vous faire de votre rendez-vous ?", "What would you like to do with your appointment?");
      // Etape 72 : le client voit d'abord CE qu'il a reserve (service/chambre, date, prix, statut), puis ses choix.
      let detail = "";
      try { detail = (heb ? marchand.engine.detailSejoursAVenir : marchand.engine.detailRdvsAVenir)(from) || ""; } catch (e) { detail = ""; }
      const texteCorps = (detail ? detail + "\n\n" : "") + question;
      db.logConversationMessage(merchantId, from, "client", heb ? tW(etatPourLangue, "Ma réservation", "My booking") : tW(etatPourLangue, "Mon rendez-vous", "My appointment")).catch(() => {});
      // Liste (et non plus 3 boutons) : elle laisse la place a « Menu principal » pour un marchand hybride.
      const lignesEspace = [
        { id: ID_RDV_ANNULER, title: tW(etatPourLangue, "Annuler", "Cancel"), description: heb ? tW(etatPourLangue, "Annuler ma réservation", "Cancel my booking") : tW(etatPourLangue, "Annuler mon rendez-vous", "Cancel my appointment") },
        { id: ID_RDV_REPORTER, title: tW(etatPourLangue, "Reporter", "Reschedule"), description: heb ? tW(etatPourLangue, "Changer les dates", "Change the dates") : tW(etatPourLangue, "Changer la date ou l'heure", "Change the date or time") },
        { id: ID_HUMAIN, title: tW(etatPourLangue, "Contacter un conseiller", "Contact an advisor"), description: tW(etatPourLangue, "Être mis en relation avec l'équipe", "Get connected with our team") }
      ].concat(ligneMenuPrincipal(marchand, etatPourLangue));
      const envoye = await envoyerListeWhatsApp(from, phoneNumberId, texteCorps, tW(etatPourLangue, "Mes options", "My options"), [{ title: tW(etatPourLangue, "Mon espace", "My space"), rows: lignesEspace }]).catch(() => false);
      if (envoye) db.logConversationMessage(merchantId, from, "bot", texteCorps).catch(() => {});
      else await envoyerMessageWhatsApp(from, texteCorps + "\n" + tW(etatPourLangue, "Écrivez « annuler » ou « reporter ».", "Write \"cancel\" or \"reschedule\"."), phoneNumberId);
      return;
    }

    // Etape 68 : navigation des listes de jours / heures / arrivees / nuits (voir gererNavigationDates).
    if (idInteractifClique && await gererNavigationDates(marchand, from, phoneNumberId, idInteractifClique, merchantId)) return;

    // Un clic sur une liste/un bouton (voir essayerEnvoyerMenuInteractif plus bas) arrive comme
    // message.type === "interactive" plutot que du texte libre - on le traduit en texte equivalent AVANT
    // de l'envoyer au moteur de conversation, qui n'a besoin de rien savoir de plus (meme logique de
    // reconnaissance que si le client avait tape la reponse lui-meme).
    let texteRecu = message.text?.body || "";
    if (!texteRecu && message.type === "interactive") {
      texteRecu = resoudreTexteInteractif(marchand, message.interactive, idInteractifClique) || "";
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

    // Marchand hybride : le routeur decide quel moteur recoit ce message (ou repond lui-meme par le menu a
    // deux boutons). Un marchand a un seul volet saute entierement ce bloc.
    let texteMoteur = texteRecu;
    let optionsMoteur;
    let suffixeReponse = null;
    let reponseDeReprise = null;
    if (estHybride(entreeComplete)) {
      const decision = entreeComplete.routeur.traiter(from, texteRecu);
      if (decision.type === "menu") {
        console.log(`[${merchantId}] Marchand hybride : menu des volets envoye a ${from}.`);
        const boutonsVolets = decision.boutons.map((b) => ({
          volet: b.volet, id: b.volet === "catalogue" ? ID_VOLET_CATALOGUE : b.volet === "hebergement" ? ID_VOLET_HEBERGEMENT : b.volet === "transport" ? ID_VOLET_TRANSPORT : ID_VOLET_SERVICE, title: b.title
        }));
        // Etape 70 : ce que le client a deja en cours (panier, rendez-vous, sejour) passe EN PREMIER (section « Mon espace »).
        const etatMenu = { langue: (entreeComplete.routeur.etatDe(from) || {}).langue || "fr" };
        const elements = elementsEspace(entreeComplete, from, etatMenu);
        // Etape 71 : le menu principal est TOUJOURS une liste deroulante (meme geste que partout ailleurs), jamais des boutons.
        // Titre de section limite a 24 caracteres par WhatsApp.
        const lignesVolets = boutonsVolets.map((b) => ({ id: b.id, title: tronquerTexte(b.title, 24), description: tronquerTexte(descriptionVolet(b.volet, etatMenu), 72) }));
        const sectionsMenu = [];
        if (elements.length) sectionsMenu.push({ title: tW(etatMenu, "Mon espace", "My space"), rows: elements.map((e) => ({ id: e.id, title: tronquerTexte(e.title, 24), description: tronquerTexte(e.description, 72) })) });
        sectionsMenu.push({ title: tW(etatMenu, "Que voulez-vous faire ?", "What do you want to do?"), rows: lignesVolets });
        const menuEnvoye = await envoyerListeWhatsApp(from, phoneNumberId, decision.texte, tW(etatMenu, "Ouvrir le menu", "Open menu"), sectionsMenu).catch(() => false);
        if (!menuEnvoye) await envoyerMessageWhatsApp(from, decision.texte, phoneNumberId);
        return;
      }
      marchand = vueEntree(entreeComplete, decision.volet);
      texteMoteur = decision.texte;
      suffixeReponse = decision.suffixe || null;
      if (decision.sansJournalClient) optionsMoteur = { sansJournalClient: true };
      if (decision.type === "reprise") reponseDeReprise = decision.reponse;
      console.log(`[${merchantId}] Marchand hybride : message de ${from} confie au volet "${decision.volet}"${decision.type === "reprise" ? " (reprise de sa derniere question)" : ""}.`);
    }

    // Reprise (client revenu dans un volet en plein parcours) : on rejoue sa derniere question telle quelle.
    // Etape 63 : une annulation demandee par le BOUTON « Annuler » du menu doit etre confirmee (Oui/Non).
    if (idInteractifClique === ID_RDV_ANNULER) optionsMoteur = Object.assign({}, optionsMoteur, { confirmerAnnulation: true });
    let reponse = reponseDeReprise !== null ? reponseDeReprise : marchand.engine.handleMessage(from, texteMoteur, optionsMoteur);
    if (reponse && suffixeReponse) reponse += suffixeReponse;

    // Une reponse "vide" (null) signifie que la conversation est en pause pour un humain (voir shared.js)
    // - on reste volontairement silencieux, le marchand repondra depuis /admin.
    if (reponse) {
      // Image d'accueil WhatsApp du marchand (facultative, voir /api/marchands/:id/image-accueil-whatsapp -
      // VOLONTAIREMENT distincte du logo /admin, voir le commentaire au-dessus de ces routes) : envoyee en
      // PREMIER, avant le message de bienvenue/porte de langue, au tout premier contact d'un client -
      // jamais aux messages suivants (sh.estMessageChoixLangue ne reconnait QUE ce message precis).
      // Best-effort : un echec ici ne doit jamais empecher le client de recevoir la vraie reponse juste
      // apres.
      if (marchand.merchant.imageAccueilWhatsappUrl && sh.estMessageChoixLangue(reponse)) {
        try {
          await envoyerImageWhatsApp(from, marchand.merchant.imageAccueilWhatsappUrl, null, phoneNumberId);
        } catch (erreur) {
          console.error(`[${merchantId}] Echec de l'envoi de l'image d'accueil au premier contact (ignore) :`, erreur);
        }
      }
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
const ID_MODIFIER = "IZY_MODIFIER"; // Etape 49 : bouton "Modifier" de la confirmation de commande
const PREFIXE_CRENEAU = "IZY_SLOT_";
// Etape 63 : menu « Mon rendez-vous » (volet service) - ligne de la liste des services, boutons Annuler/Reporter,
// et liste cliquable pour choisir parmi plusieurs rendez-vous (le clic = le numero, comme les creneaux).
const ID_MON_RDV = "IZY_MON_RDV";
const ID_RDV_ANNULER = "IZY_RDV_ANNULER";
const ID_RDV_REPORTER = "IZY_RDV_REPORTER";
const PREFIXE_RDV_CHOIX = "IZY_RDVCHOIX_";
const PREFIXE_VOIR_PLUS = "IZY_PLUS_";
// Panier multi-articles (moteur catalogue uniquement) : voir conversation.js (sh.demandeVoirPanier, stage
// "viewing_cart") et essayerEnvoyerMenuInteractif plus bas.
const ID_PANIER = "IZY_PANIER";
const ID_AUTRE_ARTICLE = "IZY_AUTRE";
const ID_PANIER_CONTINUER = "IZY_PANIER_CONTINUER";
const ID_PANIER_TERMINER = "IZY_PANIER_TERMINER";
// Etape 73 : « Ma commande » (espace client). Une commande « Nouvelle » est modifiable par le client ; une commande confirmee est verrouillee.
const ID_MA_COMMANDE = "IZY_MA_COMMANDE";
const ID_CMD_CONFIRMER = "IZY_CMD_CONFIRMER";
const ID_CMD_ARTICLES = "IZY_CMD_ARTICLES";
const ID_CMD_COORD = "IZY_CMD_COORD";
const ID_CMD_ANNULER = "IZY_CMD_ANNULER";
const ID_CMD_ANNULER_EDIT = "IZY_CMD_ANNULER_EDIT";
const PREFIXE_CMD_GERER = "IZY_CMD_GERER_";
const STADES_ACCES_COMMANDE = ["idle", "awaiting_quantity", "awaiting_more_items", "viewing_cart", "viewing_orders", "managing_order", "awaiting_order_confirmation"];
const ID_LANG_FR = "IZY_LANG_FR";
// Menu a deux boutons d'un marchand hybride (Etape 47, voir hybride.js).
const ID_VOLET_CATALOGUE = "IZY_VOLET_CAT";
const ID_VOLET_SERVICE = "IZY_VOLET_SVC";
const ID_VOLET_HEBERGEMENT = "IZY_VOLET_HEB";
const ID_VOLET_TRANSPORT = "IZY_VOLET_TRP"; // Etape 74
const PREFIXE_TRANSPORT = "IZY_TR_"; // Etape 74 : toutes les lignes/boutons du parcours transport (le moteur les comprend directement)
const ID_MES_BILLETS = "IZY_TR_MB";
// Etape 64 : ligne cliquable « Menu principal » (marchand hybride) - equivalent du texte « menu principal » deja gere par hybride.js.
const ID_MENU_PRINCIPAL = "IZY_MENU_PRINCIPAL";
const ID_LANG_EN = "IZY_LANG_EN";
const PREFIXE_RETIRER_PANIER = "IZY_DELCART_";
// Navigation par categorie (Etape 24, 27 sept 2026 - demandee des qu'un catalogue depasse une poignee
// d'articles, ex. "Excelle Health by Vestige" et ses 71 produits sur 8 categories : une seule liste plate,
// meme paginee par "Voir plus", restait confuse). Purement de la navigation d'affichage cote serveur,
// exactement comme PREFIXE_VOIR_PLUS ci-dessus - AUCUN de ces clics ne passe par engine.handleMessage() ni
// ne modifie l'etat de conversation, voir le webhook plus bas. PREFIXE_CATEGORIE encode l'INDEX de la
// categorie (pas son nom, pour eviter tout souci d'encodage/de longueur) dans le tableau renvoye par
// construireCategoriesCatalogue (ordre stable : 1ere apparition dans le catalogue).
const PREFIXE_CATEGORIE = "IZY_CAT_";
const PREFIXE_VOIR_PLUS_CATEGORIES = "IZY_PLUSCATS_"; // pagination de la LISTE DES CATEGORIES elle-meme (rare, >9 categories)
const PREFIXE_VOIR_PLUS_DANS_CAT = "IZY_PLUSINCAT_"; // pagination DANS une categorie deja choisie : suffixe "<catIndex>_<offset>"
// Etape 68 : listes deroulantes de jours / heures (rendez-vous) et d'arrivees / nuits (chambres). Tout est sans etat : les
// ids portent la date. Un clic sur une heure, une arrivee ou une duree est converti en texte pour le moteur (voir
// resoudreTexteInteractif) ; les autres clics sont de la pure navigation (gererNavigationDates).
const PREFIXE_JOUR = "IZY_JOUR_";            // + AAAA-MM-JJ
const PREFIXE_JOURS_PAGE = "IZY_JOURS_";     // + numero de page (liste des jours)
const PREFIXE_TRANCHE = "IZY_TRANCHE_";      // + AAAA-MM-JJ_m|a|s
const PREFIXE_HEURES = "IZY_HEURES_";        // + AAAA-MM-JJ_m|a|s|t_page
const PREFIXE_HEURE = "IZY_HEURE_";          // + AAAA-MM-JJ_HHMM
const PREFIXE_ARRIVEE = "IZY_ARR_";          // + AAAA-MM-JJ
const PREFIXE_ARRIVEES_PAGE = "IZY_ARRS_";   // + numero de page (liste des arrivees)
const PREFIXE_NUITS = "IZY_NUITS_";          // + nombre de nuits
const ID_AUTRE_DATE = "IZY_AUTRE_DATE";
const ID_AUTRES_JOURS = "IZY_AUTRES_JOURS";
const ID_RETOUR_CATEGORIES = "IZY_RETOUR_CATS"; // "◀ Toutes les categories" depuis la liste d'une categorie
// Choix "reponse ecrite ici" / "etre rappele(e)" (voir sh.messageChoixContact, conversation.js /
// conversationService.js) : 2 boutons proposes juste apres une demande d'humain.
const ID_CONTACT_ECRIT = "IZY_CONTACT_ECRIT";
const ID_CONTACT_APPEL = "IZY_CONTACT_APPEL";

function tronquerTexte(texte, max) {
  const t = String(texte == null ? "" : texte);
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + "…" : t;
}

// Construit la liste plate des articles (catalogue, filtree sur `categorieFiltre` si fourni) ou services
// d'un marchand, sous une forme commune {id, nom, description} - utilisee a la fois pour l'envoi de la
// 1ere page (essayerEnvoyerMenuInteractif) et pour les pages suivantes ("Voir plus", voir le handler du
// webhook plus haut). `categorieFiltre` : chaine EXACTE renvoyee par construireCategoriesCatalogue (jamais
// pertinent pour le moteur service, qui n'a pas de categories).
function construireItemsListe(marchand, categorieFiltre) {
  const estCatalogue = marchand.engine.type === "catalogue";
  if (marchand.engine.type === "hebergement") {
    // Etape 65 : un type de chambre par ligne, avec son tarif et sa capacite
    return marchand.engine.getChambres().filter((c) => Number(c.nombre) > 0).map((c) => ({
      id: c.id, nom: c.nom, description: sh.formatFcfa(Number(c.prix) || 0) + " / nuit — " + (Number(c.capacite) || 2) + " pers."
    }));
  }
  if (!estCatalogue) {
    return marchand.engine.getServices().map((s) => ({ id: s.id, nom: s.nom, description: s.dureeMinutes + " min — " + sh.formatFcfa(s.prix) }));
  }
  let produits = marchand.engine.getCatalog();
  if (categorieFiltre != null) produits = produits.filter((p) => String(p.cat || "").trim() === categorieFiltre);
  return produits.map((p) => {
    const prixMin = (p.variantes || []).length ? Math.min(...p.variantes.map((v) => v.prix)) : null;
    return { id: p.id, nom: p.nom, description: prixMin != null ? "À partir de " + sh.formatFcfa(prixMin) : "" };
  });
}

// Categories distinctes d'un catalogue (moteur catalogue uniquement), dans l'ordre de 1ere apparition -
// une chaine vide "" designe les articles sans categorie renseignee (regroupes a part, jamais perdus).
// Renvoie [] pour un moteur service ou un catalogue vide - dans les deux cas, pas de navigation par
// categorie a proposer (voir essayerEnvoyerMenuInteractif, seuil de 2 categories minimum).
function construireCategoriesCatalogue(marchand) {
  if (marchand.engine.type !== "catalogue") return [];
  const vues = [];
  marchand.engine.getCatalog().forEach((p) => {
    const cat = String(p.cat || "").trim();
    if (vues.indexOf(cat) === -1) vues.push(cat);
  });
  return vues;
}

// Construit les lignes d'UNE page de liste WhatsApp a partir de `offset` (index de depart dans `items`) -
// max 10 lignes au total. "Parler a un conseiller" figure sur CHAQUE page (choix explicite du marchand),
// ce qui laisse 9 places pour les articles/services ; si plus de 9 restent apres cette page, la derniere
// place est prise par "Voir plus ▸" a la place d'un 9eme article, pour ne jamais depasser la limite tout
// en gardant tout le catalogue/service atteignable par clics (pas seulement les 9 premiers).
// `lignesSupplementaires` (optionnel) : lignes de navigation ajoutees avant "Contacter un conseiller" - ex.
// "◀ Autres articles" sur les listes de couleur/taille/variante, ou "◀ Toutes les categories" sur la liste
// d'une categorie (voir essayerEnvoyerMenuInteractif), pour permettre au client d'explorer le catalogue
// avant de se decider sans jamais y etre oblige. IMPORTANT : ces lignes (et "Contacter un conseiller")
// occupent chacune une des 10 places au meme titre qu'un article - le nombre d'articles affiches par page
// (et le seuil de declenchement de "Voir plus") est donc REDUIT en consequence pour ne jamais depasser la
// limite WhatsApp de 10 lignes au total, quel que soit le nombre de lignes supplementaires passees (0, 1...).
// `prefixeVoirPlus` (optionnel, defaut PREFIXE_VOIR_PLUS) : quel prefixe d'id utiliser pour la ligne "Voir
// plus ▸" - necessaire pour distinguer, cote webhook, la pagination du catalogue complet de celle d'une
// categorie ou de la liste des categories elle-meme (chacune rebatit une page differente au clic).
// Etape 63 : ligne « Mon rendez-vous » de la liste des services - UNIQUEMENT pour un moteur service et une cliente
// qui a au moins un rendez-vous a venir (sinon elle n'aurait aucun sens et prendrait une des 10 places).
function lignesMonRendezVous(marchand, telephone, etat) {
  try {
    if (marchand && marchand.engine && marchand.engine.type === "hebergement" && typeof marchand.engine.nbSejoursAVenir === "function") {
      if (!(marchand.engine.nbSejoursAVenir(telephone) > 0)) return [];
      return [{ id: ID_MON_RDV, title: tW(etat, "Ma réservation", "My booking"), description: tW(etat, "Annuler ou reporter", "Cancel or reschedule") }];
    }
    if (!marchand || !marchand.engine || marchand.engine.type !== "service" || typeof marchand.engine.nbRdvsAVenir !== "function") return [];
    if (!(marchand.engine.nbRdvsAVenir(telephone) > 0)) return [];
    return [{ id: ID_MON_RDV, title: tW(etat, "Mon rendez-vous", "My appointment"), description: tW(etat, "Annuler ou reporter", "Cancel or reschedule") }];
  } catch (e) { return []; }
}

// Etape 69 (placee en PREMIERE ligne depuis l'Etape 70) : ligne « Mon panier (N) » de la liste des produits, UNIQUEMENT pour un client qui a deja un panier en cours
// (articles ajoutes, commande pas encore validee). Un clic equivaut a ecrire « voir mon panier » (voir resoudreTexteInteractif).
function lignesMonPanier(marchand, etat) {
  try {
    if (!marchand || !marchand.engine || marchand.engine.type !== "catalogue") return [];
    const out = [];
    const n = etat && Array.isArray(etat.cart) ? etat.cart.length : 0;
    if (n > 0) out.push({ id: ID_PANIER, title: tW(etat, "Mon panier (" + n + ")", "My cart (" + n + ")"), description: tW(etat, "Voir, modifier ou valider", "View, edit or complete") });
    // Etape 73 : « Ma commande » (uniquement si le client a une commande en cours) juste apres « Mon panier ».
    if (etat && etat.nbCommandesEnCours > 0) out.push(ligneMaCommande(etat));
    return out;
  } catch (e) { return []; }
}
function ligneMaCommande(etat) {
  return { id: ID_MA_COMMANDE, title: tW(etat, "Ma commande", "My order"), description: tW(etat, "Suivre, modifier ou annuler", "Track, edit or cancel") };
}

// Etape 70 : entrees « Mon panier / Mon rendez-vous / Ma reservation » du MENU PRINCIPAL d'un marchand hybride, uniquement pour ce que le
// client a reellement en cours dans les volets proposes (panier non vide, rendez-vous ou sejour a venir).
const PREFIXE_ESPACE = "IZY_ESPACE_"; // + panier | commande | rdv | sejour
function elementsEspace(entree, telephone, etat) {
  const out = [];
  try {
    const volets = entree.routeur.voletsUtilisables();
    if (volets.indexOf("catalogue") !== -1) {
      const e = entree.moteurs.catalogue.getEtatSession(telephone);
      const n = e && Array.isArray(e.cart) ? e.cart.length : 0;
      if (n > 0) out.push({ id: PREFIXE_ESPACE + "panier", title: tW(etat, "Mon panier (" + n + ")", "My cart (" + n + ")"), description: tW(etat, "Voir, modifier ou valider", "View, edit or complete") });
      if (typeof entree.moteurs.catalogue.nbCommandesEnCours === "function" && entree.moteurs.catalogue.nbCommandesEnCours(telephone) > 0) {
        out.push(Object.assign({}, ligneMaCommande(etat), { id: PREFIXE_ESPACE + "commande" }));
      }
    }
    if (volets.indexOf("service") !== -1 && typeof entree.moteurs.service.nbRdvsAVenir === "function" && entree.moteurs.service.nbRdvsAVenir(telephone) > 0) {
      out.push({ id: PREFIXE_ESPACE + "rdv", title: tW(etat, "Mon rendez-vous", "My appointment"), description: tW(etat, "Annuler ou reporter", "Cancel or reschedule") });
    }
    if (volets.indexOf("hebergement") !== -1 && typeof entree.moteurs.hebergement.nbSejoursAVenir === "function" && entree.moteurs.hebergement.nbSejoursAVenir(telephone) > 0) {
      out.push({ id: PREFIXE_ESPACE + "sejour", title: tW(etat, "Ma réservation", "My booking"), description: tW(etat, "Annuler ou reporter", "Cancel or reschedule") });
    }
    if (volets.indexOf("transport") !== -1 && typeof entree.moteurs.transport.nbBilletsAVenir === "function" && entree.moteurs.transport.nbBilletsAVenir(telephone) > 0) {
      out.push({ id: PREFIXE_ESPACE + "billets", title: tW(etat, "Mes billets", "My tickets"), description: tW(etat, "Voir ou annuler", "View or cancel") });
    }
  } catch (e) { return []; }
  return out;
}
function descriptionVolet(volet, etat) {
  if (volet === "catalogue") return tW(etat, "Voir nos produits", "Browse our products");
  if (volet === "hebergement") return tW(etat, "Réserver une chambre", "Book a room");
  if (volet === "transport") return tW(etat, "Réserver un billet", "Book a ticket");
  return tW(etat, "Prendre un rendez-vous", "Book an appointment");
}

// Etape 64 : pour un marchand HYBRIDE (au moins deux volets utilisables), ligne « Menu principal » qui ramene au menu
// a deux ou trois boutons (produits / rendez-vous / chambres). Vide pour un marchand a un seul volet : rien ne change pour lui.
// Etape 65 : libelles de la liste d'accueil selon le type (catalogue : articles ; service : services ; hebergement : chambres).
function libellesListeAccueil(marchand, etat) {
  const type = marchand.engine.type;
  if (type === "catalogue") return { bouton: tW(etat, "Voir les articles", "See items"), section: tW(etat, "Nos articles", "Our items"), suite: tW(etat, "Voici la suite de nos articles :", "Here are more of our items:"), journal: "Voir plus d'articles", repli: "" };
  if (type === "hebergement") return { bouton: tW(etat, "Voir les chambres", "See rooms"), section: tW(etat, "Nos chambres", "Our rooms"), suite: tW(etat, "Voici la suite de nos chambres :", "Here are more of our rooms:"), journal: "Voir plus de chambres", repli: "" };
  return { bouton: tW(etat, "Voir les services", "See services"), section: tW(etat, "Nos services", "Our services"), suite: tW(etat, "Voici la suite de nos services :", "Here are more of our services:"), journal: "Voir plus de services", repli: "" };
}

function ligneMenuPrincipal(marchand, etat) {
  try {
    if (!marchand || !marchand.routeur || typeof marchand.routeur.voletsUtilisables !== "function") return [];
    if (marchand.routeur.voletsUtilisables().length < 2) return [];
    return [{ id: ID_MENU_PRINCIPAL, title: tW(etat, "◀ Menu principal", "◀ Main menu"), description: tW(etat, "Changer de rubrique", "Switch section") }];
  } catch (e) { return []; }
}

function construireLignesListe(items, offset, etat, lignesSupplementaires, prefixeVoirPlus, lignesEnTete) {
  const supplementaires = lignesSupplementaires || [];
  const enTete = lignesEnTete || []; // Etape 70 : « Mon panier » / « Mon rendez-vous » / « Ma reservation » en PREMIERE ligne
  const placesReservees = 1 + supplementaires.length + enTete.length; // "Contacter un conseiller" + lignes supplementaires
  const maxSansVoirPlus = 10 - placesReservees;
  const restant = items.length - offset;
  const inclureVoirPlus = restant > maxSansVoirPlus;
  const nbAffiches = inclureVoirPlus ? maxSansVoirPlus - 1 : Math.max(0, Math.min(restant, maxSansVoirPlus));
  const page = items.slice(offset, offset + nbAffiches);
  const rows = enTete.slice().concat(page.map((it) => ({
    id: it.id,
    title: tronquerTexte(it.nom, 24),
    description: tronquerTexte(it.description, 72)
  })));
  if (inclureVoirPlus) {
    rows.push({ id: (prefixeVoirPlus || PREFIXE_VOIR_PLUS) + (offset + nbAffiches), title: tW(etat, "Voir plus ▸", "See more ▸") });
  }
  supplementaires.forEach((ligne) => rows.push(ligne));
  rows.push({ id: ID_HUMAIN, title: tW(etat, "Contacter un conseiller", "Contact an advisor"), description: tW(etat, "Être mis en relation avec l'équipe", "Get connected with our team") });
  return rows;
}

// Ecran "categories" (Etape 24) : liste des categories distinctes du catalogue, avec pagination si plus de
// 9 categories (le prefixe PREFIXE_VOIR_PLUS_CATEGORIES permet au webhook de distinguer cette pagination-la
// de celle d'une categorie individuelle ou de l'ancien catalogue plat). Reutilise pour l'ecran initial
// (offset 0, depuis essayerEnvoyerMenuInteractif) et pour "Voir plus" sur cette meme liste.
async function envoyerEcranCategories(destinataire, phoneNumberId, marchand, offset, texteCorps, etat) {
  const categories = construireCategoriesCatalogue(marchand);
  const itemsCategories = categories.map((cat, i) => ({
    id: PREFIXE_CATEGORIE + i,
    nom: cat || tW(etat, "Autres articles", "Other items"),
    description: ""
  }));
  const rows = construireLignesListe(itemsCategories, offset, etat, ligneMenuPrincipal(marchand, etat), PREFIXE_VOIR_PLUS_CATEGORIES, lignesMonPanier(marchand, etat));
  return envoyerListeWhatsApp(
    destinataire, phoneNumberId, texteCorps,
    tW(etat, "Voir les catégories", "See categories"),
    [{ title: tW(etat, "Nos catégories", "Our categories"), rows }]
  );
}

// Ecran "articles d'une categorie" (Etape 24) : meme pagination que le catalogue plat historique (via
// construireItemsListe(marchand, categorieFiltre)), plus une ligne de retour "◀ Toutes les categories"
// (ID_RETOUR_CATEGORIES) inseree avant "Contacter un conseiller" pour ne jamais enfermer le client dans une
// categorie. L'id de "Voir plus" encode "<catIndex>_<offset>" apres PREFIXE_VOIR_PLUS_DANS_CAT, pour que le
// webhook sache a la fois de quelle categorie il s'agit et a quelle page reprendre au prochain clic.
// Si l'index de categorie est invalide (catalogue modifie entre-temps) ou la categorie vide, on retombe
// simplement sur l'ecran des categories plutot que d'echouer silencieusement.
async function envoyerEcranArticlesCategorie(destinataire, phoneNumberId, marchand, catIndex, offset, texteCorps, etat) {
  const categories = construireCategoriesCatalogue(marchand);
  const nomCategorie = categories[catIndex];
  if (nomCategorie === undefined) return envoyerEcranCategories(destinataire, phoneNumberId, marchand, 0, texteCorps, etat);
  const items = construireItemsListe(marchand, nomCategorie);
  if (!items.length) return envoyerEcranCategories(destinataire, phoneNumberId, marchand, 0, texteCorps, etat);
  const ligneRetour = { id: ID_RETOUR_CATEGORIES, title: tW(etat, "◀ Toutes les catégories", "◀ All categories") };
  const rows = construireLignesListe(items, offset, etat, [ligneRetour].concat(ligneMenuPrincipal(marchand, etat)), PREFIXE_VOIR_PLUS_DANS_CAT + catIndex + "_", lignesMonPanier(marchand, etat));
  return envoyerListeWhatsApp(
    destinataire, phoneNumberId, texteCorps,
    tW(etat, "Voir les articles", "See items"),
    [{ title: tronquerTexte(nomCategorie || tW(etat, "Autres articles", "Other items"), 24), rows }]
  );
}

// ---------------- Etape 68 : listes de jours / heures / arrivees / nuits ----------------
// Chaque liste respecte la limite WhatsApp de 10 lignes : au plus 7 jours (ou 8 heures) + « Voir plus » + « Autre date »
// + « Contacter un conseiller ». La saisie libre reste toujours possible (le texte du message l'indique).
const TRANCHES_HORAIRES = {
  m: { fr: "Matin", en: "Morning", descFr: "Avant 12h", descEn: "Before 12 pm", dans: (h) => h < 12 },
  a: { fr: "Après-midi", en: "Afternoon", descFr: "De 12h à 18h", descEn: "12 pm to 6 pm", dans: (h) => h >= 12 && h < 18 },
  s: { fr: "Soir", en: "Evening", descFr: "À partir de 18h", descEn: "From 6 pm", dans: (h) => h >= 18 }
};
function ligneConseillerListe(etat) {
  return { id: ID_HUMAIN, title: tW(etat, "Contacter un conseiller", "Contact an advisor"), description: tW(etat, "Être mis en relation avec l'équipe", "Get connected with our team") };
}
function ligneAutreDate(etat, duree) {
  return { id: ID_AUTRE_DATE, title: duree ? tW(etat, "Autre durée (à écrire)", "Other length (type it)") : tW(etat, "Autre date (à écrire)", "Other date (type it)") };
}
function invitationListe(texte, etat, avecHeure) {
  const fin = avecHeure
    ? tW(etat, "\n\nChoisissez dans la liste, ou écrivez le jour et l'heure.", "\n\nPick from the list, or type the day and time.")
    : tW(etat, "\n\nChoisissez dans la liste, ou écrivez vos dates.", "\n\nPick from the list, or type your dates.");
  return tronquerTexte(String(texte), 1000 - fin.length) + fin;
}
async function envoyerListeJoursRdv(destinataire, phoneNumberId, marchand, page, texteCorps, etat) {
  const d = typeof marchand.engine.getChoixJours === "function" ? marchand.engine.getChoixJours(destinataire, page) : null;
  if (!d || !d.jours.length) return false;
  const rows = d.jours.map((j) => ({ id: PREFIXE_JOUR + j.id, title: tronquerTexte(j.label, 24), description: tronquerTexte(j.description, 72) }));
  if (d.suite) rows.push({ id: PREFIXE_JOURS_PAGE + (d.page + 1), title: tW(etat, "Voir plus de jours ▸", "See more days ▸") });
  rows.push(ligneAutreDate(etat, false));
  rows.push(ligneConseillerListe(etat));
  return envoyerListeWhatsApp(destinataire, phoneNumberId, texteCorps, tW(etat, "Choisir un jour", "Choose a day"), [{ title: tW(etat, "Jours disponibles", "Available days"), rows }]);
}
// Heures libres d'un jour. Renvoie "ok" (liste envoyee), "perime" (la conversation n'est plus a cette etape) ou "complet"
// (plus aucun creneau ce jour-la). Plus de 8 creneaux : d'abord les tranches Matin / Apres-midi / Soir (si au moins deux
// sont non vides), puis les heures de la tranche, par pages.
async function envoyerListeHeures(destinataire, phoneNumberId, marchand, jourIso, tranche, page, etat, texteCorps) {
  const d = typeof marchand.engine.getChoixHeures === "function" ? marchand.engine.getChoixHeures(destinataire, jourIso) : null;
  if (!d) return "perime";
  if (!d.creneaux.length) return "complet";
  const retour = { id: ID_AUTRES_JOURS, title: tW(etat, "◀ Autres jours", "◀ Other days") };
  if (!tranche && d.creneaux.length > 8) {
    const groupes = ["m", "a", "s"].map((k) => ({ k, n: d.creneaux.filter((c) => TRANCHES_HORAIRES[k].dans(c.heure)).length })).filter((g) => g.n > 0);
    if (groupes.length >= 2) {
      const rows = groupes.map((g) => ({
        id: PREFIXE_TRANCHE + jourIso + "_" + g.k,
        title: tW(etat, TRANCHES_HORAIRES[g.k].fr, TRANCHES_HORAIRES[g.k].en),
        description: tW(etat, TRANCHES_HORAIRES[g.k].descFr, TRANCHES_HORAIRES[g.k].descEn) + " — " + tW(etat, g.n + (g.n > 1 ? " créneaux" : " créneau"), g.n + (g.n > 1 ? " slots" : " slot"))
      }));
      rows.push(retour, ligneConseillerListe(etat));
      const corps = texteCorps || tW(etat, "Quel moment de la journée vous convient le " + d.jourLabel + " ?", "What time of day suits you on " + d.jourLabel + "?");
      const ok = await envoyerListeWhatsApp(destinataire, phoneNumberId, corps, tW(etat, "Choisir un moment", "Choose a period"), [{ title: tronquerTexte(d.jourLabel, 24), rows }]);
      return ok ? "ok" : "echec";
    }
  }
  const t = tranche || "t";
  const creneaux = t === "t" ? d.creneaux : d.creneaux.filter((c) => TRANCHES_HORAIRES[t] && TRANCHES_HORAIRES[t].dans(c.heure));
  if (!creneaux.length) return "complet";
  const debut = page > 0 ? page * 7 : 0;
  const reste = creneaux.length - debut;
  const affiches = reste <= 8 ? creneaux.slice(debut) : creneaux.slice(debut, debut + 7);
  const rows = affiches.map((c) => ({ id: PREFIXE_HEURE + jourIso + "_" + c.id.replace(":", ""), title: tronquerTexte(c.label, 24), description: tronquerTexte(d.jourLabel, 72) }));
  if (reste > 8) rows.push({ id: PREFIXE_HEURES + jourIso + "_" + t + "_" + (page + 1), title: tW(etat, "Voir plus d'heures ▸", "See more times ▸") });
  rows.push(retour, ligneConseillerListe(etat));
  const corps = texteCorps || tW(etat, "Quelle heure vous convient le " + d.jourLabel + " ?", "What time suits you on " + d.jourLabel + "?");
  const ok = await envoyerListeWhatsApp(destinataire, phoneNumberId, corps, tW(etat, "Choisir une heure", "Choose a time"), [{ title: tronquerTexte(d.jourLabel, 24), rows }]);
  return ok ? "ok" : "echec";
}
async function envoyerListeArrivees(destinataire, phoneNumberId, marchand, page, texteCorps, etat) {
  const d = typeof marchand.engine.getChoixArrivees === "function" ? marchand.engine.getChoixArrivees(destinataire, page) : null;
  if (!d || !d.jours.length) return false;
  const rows = d.jours.map((j) => ({ id: PREFIXE_ARRIVEE + j.id, title: tronquerTexte(j.label, 24), description: tronquerTexte(j.description, 72) }));
  if (d.suite) rows.push({ id: PREFIXE_ARRIVEES_PAGE + (d.page + 1), title: tW(etat, "Voir plus de dates ▸", "See more dates ▸") });
  rows.push(ligneAutreDate(etat, false));
  rows.push(ligneConseillerListe(etat));
  return envoyerListeWhatsApp(destinataire, phoneNumberId, texteCorps, tW(etat, "Choisir l'arrivée", "Choose arrival"), [{ title: tW(etat, "Dates d'arrivée", "Arrival dates"), rows }]);
}
async function envoyerListeNuits(destinataire, phoneNumberId, marchand, texteCorps, etat) {
  const d = typeof marchand.engine.getChoixNuits === "function" ? marchand.engine.getChoixNuits(destinataire) : null;
  if (!d || !d.options.length) return false;
  const rows = d.options.map((o) => ({ id: PREFIXE_NUITS + o.nuits, title: tronquerTexte(o.label, 24), description: tronquerTexte(o.description, 72) }));
  rows.push(ligneAutreDate(etat, true));
  rows.push(ligneConseillerListe(etat));
  return envoyerListeWhatsApp(destinataire, phoneNumberId, texteCorps, tW(etat, "Choisir la durée", "Choose length"), [{ title: tW(etat, "Nombre de nuits", "Number of nights"), rows }]);
}

// Clics de NAVIGATION des listes ci-dessus (aucun changement d'etat de la conversation, comme les categories), et
// detection des listes perimees (la conversation a avance entre l'envoi de la liste et le clic). Renvoie true si le
// clic est entierement traite ici ; false = laisser le moteur le recevoir (heure, arrivee ou duree choisie).
async function gererNavigationDates(marchand, from, phoneNumberId, id, merchantId) {
  if (!id || !marchand || !marchand.engine || typeof marchand.engine.getEtatSession !== "function") return false;
  const estDate = [PREFIXE_JOUR, PREFIXE_JOURS_PAGE, PREFIXE_TRANCHE, PREFIXE_HEURES, PREFIXE_HEURE, PREFIXE_ARRIVEE, PREFIXE_ARRIVEES_PAGE, PREFIXE_NUITS].some((p) => id.indexOf(p) === 0) || id === ID_AUTRE_DATE || id === ID_AUTRES_JOURS;
  if (!estDate) return false;
  const etat = marchand.engine.getEtatSession(from);
  const journaliser = (client, bot) => {
    if (client) db.logConversationMessage(merchantId, from, "client", client).catch(() => {});
    if (bot) db.logConversationMessage(merchantId, from, "bot", bot).catch(() => {});
  };
  const perime = async () => {
    const msg = tW(etat, "Cette liste n'est plus d'actualité. Poursuivez la conversation ci-dessus, ou écrivez « menu » pour recommencer.", "This list is no longer current. Please carry on with the conversation above, or write \"menu\" to start over.");
    journaliser(null, msg);
    await envoyerMessageWhatsApp(from, msg, phoneNumberId);
    return true;
  };
  const estService = marchand.engine.type === "service";
  const estHeb = marchand.engine.type === "hebergement";

  if (id === ID_AUTRE_DATE) {
    if (!etat) return perime();
    const msg = estHeb
      ? (etat.choixDate === "nuits" ? tW(etat, "Écrivez le nombre de nuits ou votre date de départ (ex : 4 nuits, ou départ le 15 novembre).", "Write the number of nights or your departure date (e.g. 4 nights, or leaving 15 November).")
        : tW(etat, "Écrivez vos dates de séjour (ex : du 12 au 15 novembre, ou vendredi pour 2 nuits).", "Write your stay dates (e.g. from 12 to 15 November, or Friday for 2 nights)."))
      : tW(etat, "Écrivez le jour et l'heure souhaités (ex : vendredi à 10h, ou 25/10 à 14h30).", "Write the day and time you would like (e.g. Friday at 10am, or 25/10 at 2:30 pm).");
    journaliser(tW(etat, "Autre date", "Other date"), msg);
    await envoyerMessageWhatsApp(from, msg, phoneNumberId);
    return true;
  }

  if (id === ID_AUTRES_JOURS || id.indexOf(PREFIXE_JOURS_PAGE) === 0) {
    const page = id === ID_AUTRES_JOURS ? 0 : Number(id.slice(PREFIXE_JOURS_PAGE.length)) || 0;
    const corps = tW(etat, "Quel jour vous convient ?", "Which day suits you?");
    const ok = estService ? await envoyerListeJoursRdv(from, phoneNumberId, marchand, page, corps, etat).catch(() => false) : false;
    if (!ok) return perime();
    journaliser(id === ID_AUTRES_JOURS ? tW(etat, "Autres jours", "Other days") : tW(etat, "Voir plus de jours", "See more days"), corps);
    return true;
  }

  if (id.indexOf(PREFIXE_JOUR) === 0 || id.indexOf(PREFIXE_TRANCHE) === 0 || id.indexOf(PREFIXE_HEURES) === 0) {
    if (!estService) return perime();
    let jourIso, tranche = null, page = 0, libelle;
    if (id.indexOf(PREFIXE_JOUR) === 0) { jourIso = id.slice(PREFIXE_JOUR.length); libelle = jourIso; }
    else if (id.indexOf(PREFIXE_TRANCHE) === 0) { const r = id.slice(PREFIXE_TRANCHE.length).split("_"); jourIso = r[0]; tranche = r[1] || null; libelle = jourIso + " " + (tranche || ""); }
    else { const r = id.slice(PREFIXE_HEURES.length).split("_"); jourIso = r[0]; tranche = r[1] || null; page = Number(r[2]) || 0; libelle = jourIso + " " + (tranche || ""); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(jourIso)) return perime();
    if (tranche && !TRANCHES_HORAIRES[tranche] && tranche !== "t") tranche = null;
    const resultat = await envoyerListeHeures(from, phoneNumberId, marchand, jourIso, tranche, page, etat).catch(() => "echec");
    if (resultat === "perime") return perime();
    if (resultat === "complet") {
      const msg = tW(etat, "Désolée, il n'y a plus de place ce jour-là. Choisissez un autre jour :", "Sorry, there is nothing left that day. Please pick another day:");
      journaliser(libelle, msg);
      const ok = await envoyerListeJoursRdv(from, phoneNumberId, marchand, 0, msg, etat).catch(() => false);
      if (!ok) await envoyerMessageWhatsApp(from, msg, phoneNumberId);
      return true;
    }
    if (resultat === "echec") {
      await envoyerMessageWhatsApp(from, tW(etat, "Écrivez l'heure souhaitée (ex : 10h30).", "Write the time you would like (e.g. 10:30 am)."), phoneNumberId);
      return true;
    }
    journaliser(libelle, tW(etat, "Quelle heure vous convient ?", "What time suits you?"));
    return true;
  }

  if (id.indexOf(PREFIXE_ARRIVEES_PAGE) === 0) {
    if (!estHeb) return perime();
    const page = Number(id.slice(PREFIXE_ARRIVEES_PAGE.length)) || 0;
    const corps = tW(etat, "Voici d'autres dates d'arrivée possibles :", "Here are more possible arrival dates:");
    const ok = await envoyerListeArrivees(from, phoneNumberId, marchand, page, corps, etat).catch(() => false);
    if (!ok) return perime();
    journaliser(tW(etat, "Voir plus de dates", "See more dates"), corps);
    return true;
  }

  // Heure, arrivee ou duree choisie : le moteur la recevra comme du texte - sauf si la liste est perimee.
  if (id.indexOf(PREFIXE_HEURE) === 0) {
    const r = id.slice(PREFIXE_HEURE.length).split("_");
    if (!estService || !marchand.engine.getChoixHeures(from, r[0])) return perime();
    return false;
  }
  if (id.indexOf(PREFIXE_ARRIVEE) === 0) {
    if (!estHeb || !etat || etat.choixDate !== "arrivee") return perime();
    return false;
  }
  if (id.indexOf(PREFIXE_NUITS) === 0) {
    if (!estHeb || !etat || etat.choixDate !== "nuits") return perime();
    return false;
  }
  return false;
}

// Traduit l'id d'une ligne de liste ou d'un bouton cliques par le client en texte equivalent - le moteur
// de conversation n'en sait rien, il recoit exactement ce qu'il recevrait si le client avait tape ce
// texte lui-meme (voir matchProduct/matchService/matchCouleur/matchTaille/demandeUnHumain/
// parseAffirmative/parseNegative). Les lignes de couleur/taille/variante (voir plus bas) utilisent
// directement le libelle affiche comme id : matchCouleur()/matchTaille() le reconnaissent nativement,
// donc aucune correspondance dediee n'est necessaire pour elles ici.
function resoudreTexteInteractif(marchand, interactive, idForce) {
  if (!interactive) return null;
  let id = null;
  if (interactive.type === "list_reply") id = interactive.list_reply?.id;
  else if (interactive.type === "button_reply") id = interactive.button_reply?.id;
  if (idForce) id = idForce; // Etape 70 : id reecrit par le webhook (clic sur « Mon panier » du menu principal)
  if (!id) return null;

  if (id === ID_LANG_FR) return "fr"; // reponse a la porte bilingue (voir sh.detecterChoixLangueInitial)
  if (id === ID_LANG_EN) return "en";
  if (id === ID_VOLET_CATALOGUE) return JETON_VOLET_CATALOGUE; // choix du volet (marchand hybride, voir hybride.js)
  if (id === ID_VOLET_SERVICE) return JETON_VOLET_SERVICE;
  if (id === ID_VOLET_HEBERGEMENT) return JETON_VOLET_HEBERGEMENT;
  if (id === ID_VOLET_TRANSPORT) return JETON_VOLET_TRANSPORT;
  if (id === ID_MENU_PRINCIPAL) return "menu principal"; // Etape 64 : reconnu par hybride.js (RE_MENU_PRINCIPAL)
  if (id === ID_HUMAIN) return "un conseiller";
  if (id === ID_CONTACT_ECRIT) return "réponse écrite ici";
  if (id === ID_CONTACT_APPEL) return "être rappelé";
  if (id.indexOf(PREFIXE_TRANSPORT) === 0) return id; // Etape 74 : le moteur transport lit directement les identifiants de ses lignes et boutons
  if (id === ID_OUI) return "oui";
  if (id === ID_NON) return "non";
  if (id === ID_MODIFIER) return "modifier";
  if (id === ID_RDV_ANNULER) return "annuler mon rendez-vous"; // Etape 63
  if (id === ID_RDV_REPORTER) return "reporter mon rendez-vous";
  if (id.indexOf(PREFIXE_RDV_CHOIX) === 0) return String(Number(id.slice(PREFIXE_RDV_CHOIX.length)) + 1); // position 1-based dans la liste
  if (id === ID_PANIER) return "voir mon panier";
  if (id === ID_MA_COMMANDE) return "ma commande"; // Etape 73
  if (id === ID_CMD_CONFIRMER) return "confirmer ma commande";
  if (id === ID_CMD_ARTICLES) return "modifier les articles";
  if (id === ID_CMD_COORD) return "modifier mes coordonnées";
  if (id === ID_CMD_ANNULER) return "annuler ma commande";
  if (id === ID_CMD_ANNULER_EDIT) return "annuler";
  if (id.indexOf(PREFIXE_CMD_GERER) === 0) return "gérer CMD-" + String(Number(id.slice(PREFIXE_CMD_GERER.length))).padStart(4, "0");
  if (id === ID_AUTRE_ARTICLE) return "autre chose";
  if (id === ID_PANIER_CONTINUER) return "continuer mes achats";
  if (id === ID_PANIER_TERMINER) return "terminé";
  if (id.indexOf(PREFIXE_RETIRER_PANIER) === 0) return String(Number(id.slice(PREFIXE_RETIRER_PANIER.length)) + 1); // position 1-based dans le panier
  if (id.indexOf(PREFIXE_CRENEAU) === 0) return String(Number(id.slice(PREFIXE_CRENEAU.length)) + 1); // "1"/"2"/"3"
  // Etape 68 : heure / arrivee / duree choisies dans les listes -> jeton ou texte que le moteur comprend deja.
  if (id.indexOf(PREFIXE_HEURE) === 0) {
    const r = id.slice(PREFIXE_HEURE.length).split("_");
    if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && /^\d{4}$/.test(r[1] || "")) return "__creneau:" + r[0] + " " + r[1].slice(0, 2) + ":" + r[1].slice(2) + "__";
  }
  if (id.indexOf(PREFIXE_ARRIVEE) === 0) return id.slice(PREFIXE_ARRIVEE.length); // « AAAA-MM-JJ »
  if (id.indexOf(PREFIXE_NUITS) === 0) { const n = Number(id.slice(PREFIXE_NUITS.length)) || 1; return n + (n > 1 ? " nuits" : " nuit"); }

  // Id d'un article ou d'un service connu : on renvoie son nom exact, que matchProduct()/matchService()
  // reconnaissent deja nativement (il figure toujours dans leurs mots-cles). Sinon (couleur/taille/
  // variante, ou tres rare course : l'article a ete retire du catalogue entre l'envoi de la liste et le
  // clic du client) on renvoie l'id tel quel - il EST deja le texte a interpreter dans tous les autres cas.
  if (marchand.engine.type === "catalogue") {
    const p = marchand.engine.getCatalog().filter((x) => x.id === id)[0];
    return p ? p.nom : id;
  }
  if (marchand.engine.type === "hebergement") {
    const c = marchand.engine.getChambres().filter((x) => x.id === id)[0];
    return c ? c.nom : id;
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

// Etape 50 (13 oct 2026) : le moteur catalogue annonce "Quel article vous interesse ? Nous avons : A, B, C..."
// en listant TOUS les articles dans le texte. Avec un grand catalogue (cas reel : 62 parfums), ce texte
// devient un pave illisible ET depasse la limite WhatsApp de 1024 caracteres pour le corps d'un message
// interactif (la fin etait coupee en plein mot). Quand le catalogue depasse SEUIL_LISTE_COMPACTE articles
// et qu'un menu cliquable accompagne le message (categories ou articles), on retire donc cette liste du
// corps : elle est de toute facon dans le menu. A la place on met le "message d'accueil personnalise" du
// marchand (Parametres) s'il en a un - il est ainsi rappele a chaque affichage du catalogue - sinon une
// courte invite a toucher le bouton. Petit catalogue (<= seuil) : AUCUN changement, la liste reste dans le
// texte comme avant. Le texte de repli (si l'envoi interactif echoue) reste, lui, le texte d'origine.
// Etape 52 : la couleur par defaut "-" (articles sans couleur) ne doit pas apparaitre dans les listes WhatsApp.
function libelleVarianteClient(couleur, taille) {
  return [couleur, taille].filter((x) => { const t = String(x == null ? "" : x).trim(); return t !== "" && t !== "-" && t !== "—" && t !== "–"; }).join(" ");
}
const SEUIL_LISTE_COMPACTE = 8;
function compacterTexteMenuCatalogue(marchand, texte, etat) {
  try {
    if (!marchand || !marchand.engine || marchand.engine.type !== "catalogue") return texte;
    if ((marchand.engine.getCatalog() || []).length <= SEUIL_LISTE_COMPACTE) return texte;
    const m = String(texte).match(/^([\s\S]*?(?:[Qq]uel (?:autre )?article vous intéresse \?|[Ww]hich (?:other )?item are you interested in\?))\s*(?:Nous avons|We have)\s*:[\s\S]*$/);
    if (!m) return texte;
    const entete = m[1].trim();
    const en = etat && etat.langue === "en";
    const reglages = (marchand.engine.getSettings && marchand.engine.getSettings()) || {};
    const accueilFr = String(reglages.messageAccueilSupplementaire || "").trim();
    const accueilEn = String(reglages.messageAccueilSupplementaireEn || "").trim();
    const accueil = en ? (accueilEn || accueilFr) : (accueilFr || accueilEn);
    let corps;
    if (accueil) {
      const seule = entete.match(/^(?:Bonjour ! |Hello! )?(Quel article vous intéresse \?|Which item are you interested in\?)$/);
      corps = seule ? accueil + "\n\n" + seule[1] : entete + "\n\n" + accueil;
    } else {
      corps = entete + " " + (en ? "Tap the button below to browse our catalog." : "Touchez le bouton ci-dessous pour parcourir notre catalogue.");
    }
    return tronquerTexte(corps, 1000);
  } catch (e) {
    return texte;
  }
}

// Etape 74 : options de l'etape en cours du parcours transport, en texte numerote (Simulateur de /admin, et repli si WhatsApp refuse la liste).
// Le moteur comprend le numero, le libelle ou « retour ».
function texteOptionsTransport(etat) {
  if (!etat) return "";
  const out = [];
  if (etat.liste && etat.liste.lignes && etat.liste.lignes.length) {
    out.push(etat.liste.lignes.map((r, i) => (i + 1) + ". " + r.title + (r.description ? " — " + r.description : "")).join("\n"));
    if (etat.liste.retour) out.push(tW(etat, "(Écrivez « retour » pour revenir en arrière.)", "(Write \"back\" to go back.)"));
  } else if (etat.boutons && etat.boutons.length) {
    out.push(etat.boutons.map((b) => "[" + b.title + "]").join("  "));
  }
  return out.join("\n");
}
async function envoyerMenuTransport(marchand, destinataire, phoneNumberId, texte, etat) {
  if (etat.boutons && etat.boutons.length) {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, etat.boutons.slice(0, 3));
  }
  if (!etat.liste) return false;
  const rows = etat.liste.lignes.map((r) => ({ id: r.id, title: tronquerTexte(r.title, 24), description: tronquerTexte(r.description || "", 72) }));
  if (etat.liste.retour) rows.push({ id: PREFIXE_TRANSPORT + "BACK", title: tW(etat, "◀ Retour", "◀ Back"), description: tW(etat, "Étape précédente", "Previous step") });
  ligneMenuPrincipal(marchand, etat).forEach((r) => rows.push(r));
  rows.push({ id: ID_HUMAIN, title: tW(etat, "Contacter un conseiller", "Contact an advisor"), description: tW(etat, "Être mis en relation avec l'équipe", "Get connected with our team") });
  const ok = await envoyerListeWhatsApp(destinataire, phoneNumberId, texte, tronquerTexte(etat.liste.bouton, 20), [{ title: tronquerTexte(etat.liste.section, 24), rows: rows.slice(0, 10) }]);
  if (ok) return true;
  // WhatsApp a refuse la liste : repli en texte numerote (le client peut repondre par le numero ou le libelle).
  await envoyerMessageWhatsApp(destinataire, texte + "\n\n" + texteOptionsTransport(etat), phoneNumberId);
  return true;
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

  // Choix "reponse ecrite ici" / "etre rappele(e)" (voir sh.messageChoixContact) : pose juste apres une
  // demande d'humain, avant meme qu'un etat de session interactif soit pertinent ici - meme logique de
  // retour immediat que la porte de langue ci-dessus. La langue du message deja calcule (FR ou EN, voir
  // sh.MESSAGE_CHOIX_CONTACT_EN) determine celle des 2 boutons, `etat` n'etant pas encore disponible ici.
  if (sh.estMessageChoixContact(texte)) {
    const langueEn = texte.slice(-sh.MESSAGE_CHOIX_CONTACT_EN.length) === sh.MESSAGE_CHOIX_CONTACT_EN;
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: ID_CONTACT_ECRIT, title: langueEn ? "Reply here" : "Réponse ici" },
      { id: ID_CONTACT_APPEL, title: langueEn ? "Call me back" : "Être rappelé(e)" }
    ]);
  }

  if (typeof marchand.engine.getEtatSession !== "function") return false;
  const etat = marchand.engine.getEtatSession(destinataire);
  if (!etat) return false;

  // Etape 74 : le moteur transport fournit lui-meme la liste (ou les boutons) de l'etape en cours.
  if (marchand.engine.type === "transport") return envoyerMenuTransport(marchand, destinataire, phoneNumberId, texte, etat);

  if (etat.stage === "idle" && etat.pretPourChoix) {
    const estCatalogue = marchand.engine.type === "catalogue";
    texte = compacterTexteMenuCatalogue(marchand, texte, etat); // Etape 50 : voir plus haut
    // Etape 65 : la liste des chambres figure deja dans le menu cliquable : on la retire du corps du message.
    if (marchand.engine.type === "hebergement") {
      const sans = texte.split("\n").filter((l) => !/^• .+ — .*\/ (nuit|night)/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (sans) texte = sans;
    }
    // Etape 70 : accueil personnalise d'un marchand rendez-vous : la liste des services est deja dans le menu, on la retire du corps.
    if (marchand.engine.type === "service" && etat.accueilPerso) {
      const sans = texte.replace(/\s*(?:Nous proposons|We offer) : [\s\S]*$/, "").trim();
      if (sans) texte = tronquerTexte(sans, 1000);
    }

    // Navigation par categorie (Etape 24) : seulement si ca a un vrai interet (2+ categories distinctes) -
    // un catalogue non categorise, ou avec une seule categorie, garde le comportement direct d'avant (liste
    // plate des articles) pour ne jamais imposer un clic supplementaire inutile a un petit marchand.
    if (estCatalogue) {
      const categories = construireCategoriesCatalogue(marchand);
      if (categories.length >= 2) {
        return envoyerEcranCategories(destinataire, phoneNumberId, marchand, 0, texte, etat);
      }
    }

    const items = construireItemsListe(marchand);
    if (!items.length) return false;
    const rows = construireLignesListe(items, 0, etat, ligneMenuPrincipal(marchand, etat), undefined, estCatalogue ? lignesMonPanier(marchand, etat) : lignesMonRendezVous(marchand, destinataire, etat));

    const lib = libellesListeAccueil(marchand, etat);
    return envoyerListeWhatsApp(destinataire, phoneNumberId, texte, lib.bouton, [{ title: lib.section, rows }]);
  }

  // Choix livraison vs retrait en boutique (voir conversation.js / retraitConfigure()) : seulement 2
  // options possibles -> boutons (avec le conseiller, ça tient exactement dans la limite de 3). Etape
  // dediee "awaiting_mode_livraison" (PAS "idle", contrairement a couleur/taille/variante ci-dessous).
  if (etat.stage === "awaiting_mode_livraison" && etat.pendingChoice && etat.pendingChoice.type === "mode_livraison") {
    const boutons = etat.pendingChoice.options.slice(0, 2).map((opt) => ({ id: String(opt), title: tronquerTexte(String(opt), 20) }));
    boutons.push({ id: ID_HUMAIN, title: tW(etat, "Contacter un conseiller", "Contact an advisor") });
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
      const libelle = pc.type === "variante" ? libelleVarianteClient(opt.couleur, opt.taille) : String(opt);
      return { id: libelle, nom: libelle, description: "" };
    });
    // Le client peut regarder cette liste sans s'y engager : une ligne le ramène directement au catalogue
    // complet (voir conversation.js — abandon de la sélection en cours si le panier n'est pas vide, elle
    // reste intacte).
    const rows = construireLignesListe(items, 0, etat, [
      { id: ID_AUTRE_ARTICLE, title: tW(etat, "◀ Autres articles", "◀ Other items"), description: tW(etat, "Revenir au catalogue complet", "Back to the full catalog") }
    ].concat(ligneMenuPrincipal(marchand, etat)));

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
    const rows = etat.cart.slice(0, etat.editOrderRef ? 5 : 6).map((it, i) => ({
      id: PREFIXE_RETIRER_PANIER + i,
      title: tronquerTexte(it.produit, 24),
      description: tronquerTexte(tW(etat, "🗑️ Retirer — ", "🗑️ Remove — ") + libelleVarianteClient(it.couleur, it.taille) + " × " + it.quantite + " — " + sh.formatFcfa(it.prixUnitaire * it.quantite), 72)
    }));
    rows.push({ id: ID_PANIER_CONTINUER, title: tronquerTexte(tW(etat, "🛍️ Continuer mes achats", "🛍️ Keep shopping"), 24) });
    rows.push({ id: ID_PANIER_TERMINER, title: tronquerTexte(etat.editOrderRef ? tW(etat, "✅ Valider les changements", "✅ Save changes") : tW(etat, "✅ Terminer ma commande", "✅ Complete my order"), 24) });
    if (etat.editOrderRef) rows.push({ id: ID_CMD_ANNULER_EDIT, title: tronquerTexte(tW(etat, "Annuler la modification", "Cancel the edit"), 24), description: tronquerTexte(tW(etat, "Garder " + etat.editOrderRef + " telle quelle", "Keep " + etat.editOrderRef + " unchanged"), 72) });
    rows.push({ id: ID_HUMAIN, title: tW(etat, "Contacter un conseiller", "Contact an advisor"), description: tW(etat, "Être mis en relation avec l'équipe", "Get connected with our team") });
    ligneMenuPrincipal(marchand, etat).forEach((l) => rows.push(l)); // Etape 72 : retour au menu principal (marchand hybride)
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

  // Rupture sur tous les modeles : "Souhaitez-vous que notre equipe vous previenne des le reassort ?" (voir
  // conversation.js, etape awaiting_reassort) - memes boutons Oui/Non que la confirmation de commande.
  // Etape 73 : « Ma commande » - une commande « Nouvelle » ouverte : actions possibles ; plusieurs commandes : choix ; confirmee : contact seulement.
  if (etat.stage === "managing_order" && etat.commandeActive) {
    const rows = [
      { id: ID_CMD_CONFIRMER, title: tW(etat, "Confirmer la commande", "Confirm the order"), description: tW(etat, "Valider " + etat.commandeActive.ref, "Confirm " + etat.commandeActive.ref) },
      { id: ID_CMD_ARTICLES, title: tW(etat, "Modifier les articles", "Edit items"), description: tW(etat, "Ajouter, retirer, changer", "Add, remove, change") },
      { id: ID_CMD_COORD, title: tW(etat, "Mes coordonnées", "My details"), description: tW(etat, "Téléphone ou adresse", "Phone or address") },
      { id: ID_CMD_ANNULER, title: tW(etat, "Annuler la commande", "Cancel the order"), description: tW(etat, "Supprimer " + etat.commandeActive.ref, "Remove " + etat.commandeActive.ref) },
      { id: ID_HUMAIN, title: tW(etat, "Contacter un conseiller", "Contact an advisor"), description: tW(etat, "Être mis en relation avec l'équipe", "Get connected with our team") }
    ].concat(ligneMenuPrincipal(marchand, etat));
    return envoyerListeWhatsApp(destinataire, phoneNumberId, texte, tW(etat, "Mes options", "My options"), [{ title: tW(etat, "Ma commande", "My order"), rows }]);
  }
  if (etat.stage === "viewing_orders") {
    const rows = (etat.commandesVue || []).slice(0, 4).map((c) => ({
      id: PREFIXE_CMD_GERER + c.id, title: c.ref,
      description: tronquerTexte(tW(etat, "À confirmer · ", "To confirm · ") + c.nbArticles + tW(etat, " article(s) · ", " item(s) · ") + sh.formatFcfa(c.prix), 72)
    }));
    rows.push({ id: ID_PANIER_CONTINUER, title: tW(etat, "Continuer mes achats", "Keep shopping"), description: tW(etat, "Retour au catalogue", "Back to the catalog") });
    rows.push({ id: ID_HUMAIN, title: tW(etat, "Contacter un conseiller", "Contact an advisor"), description: tW(etat, "Être mis en relation avec l'équipe", "Get connected with our team") });
    ligneMenuPrincipal(marchand, etat).forEach((l) => rows.push(l));
    return envoyerListeWhatsApp(destinataire, phoneNumberId, texte, tW(etat, "Mes options", "My options"), [{ title: tW(etat, "Mes commandes", "My orders"), rows }]);
  }
  if (etat.stage === "awaiting_order_cancel_confirm") {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: ID_OUI, title: tW(etat, "Oui, annuler", "Yes, cancel") },
      { id: ID_NON, title: tW(etat, "Non, la garder", "No, keep it") }
    ]);
  }
  // Etape 49 : la confirmation de COMMANDE propose un 3e bouton "Modifier" (corriger telephone/adresse).
  if (etat.stage === "awaiting_order_confirmation") {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: ID_OUI, title: tW(etat, "Oui", "Yes") },
      { id: ID_NON, title: tW(etat, "Non", "No") },
      { id: ID_MODIFIER, title: tW(etat, "Modifier", "Edit") }
    ]);
  }
  if (etat.stage === "awaiting_confirmation" || etat.stage === "awaiting_reassort") {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: ID_OUI, title: tW(etat, "Oui", "Yes") },
      { id: ID_NON, title: tW(etat, "Non", "No") }
    ]);
  }

  // Etape 63 : confirmation d'une annulation demandee par le menu (boutons Oui/Non explicites).
  if (etat.stage === "awaiting_annulation_confirm") {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: ID_OUI, title: tW(etat, "Oui, annuler", "Yes, cancel") },
      { id: ID_NON, title: tW(etat, "Non, le garder", "No, keep it") }
    ]);
  }

  // Etape 63 : plusieurs rendez-vous a venir -> liste cliquable (au lieu d'une liste numerotee a retaper).
  if (etat.stage === "awaiting_rdv_choice" && etat.rdvChoix && etat.rdvChoix.length) {
    const rows = etat.rdvChoix.slice(0, 9).map((r, i) => ({ id: PREFIXE_RDV_CHOIX + i, title: tronquerTexte(r.ref, 24), description: tronquerTexte(r.detail, 72) }));
    const titreChoix = marchand.engine.type === "hebergement" ? tW(etat, "Vos réservations", "Your bookings") : tW(etat, "Vos rendez-vous", "Your appointments");
    return envoyerListeWhatsApp(destinataire, phoneNumberId, texte, tW(etat, "Choisir", "Choose"), [{ title: titreChoix, rows }]);
  }

  // Etape 65 : nombre de personnes (hebergement) -> 3 boutons rapides ; le client peut taper un autre nombre.
  if (marchand.engine.type === "hebergement" && etat.stage === "awaiting_personnes") {
    return envoyerBoutonsWhatsApp(destinataire, phoneNumberId, texte, [
      { id: "1", title: tW(etat, "1 personne", "1 person") },
      { id: "2", title: tW(etat, "2 personnes", "2 people") },
      { id: "3", title: tW(etat, "3 personnes", "3 people") }
    ]);
  }

  // Etape 68 : le client doit donner un jour/une heure (rendez-vous) ou ses dates (chambres) -> liste deroulante, sauf si le
  // marchand a decoche l'option (le moteur ne renvoie alors aucun `choixDate`) ou si rien n'est disponible (texte seul).
  if (marchand.engine.type === "service" && etat.choixDate === true) {
    if (await envoyerListeJoursRdv(destinataire, phoneNumberId, marchand, 0, invitationListe(texte, etat, true), etat)) return true;
  }
  if (marchand.engine.type === "hebergement" && etat.choixDate === "arrivee") {
    if (await envoyerListeArrivees(destinataire, phoneNumberId, marchand, 0, invitationListe(texte, etat, false), etat)) return true;
  }
  if (marchand.engine.type === "hebergement" && etat.choixDate === "nuits") {
    if (await envoyerListeNuits(destinataire, phoneNumberId, marchand, invitationListe(texte, etat, false), etat)) return true;
  }

  if (etat.stage === "awaiting_slot_choice" && etat.proposedSlots && etat.proposedSlots.length) {
    // Libelles fournis par le moteur (langue de la session + fuseau du marchand, Etape 44/45) - jamais
    // formates ici avec le fuseau du serveur.
    const boutons = etat.proposedSlots.slice(0, 3).map((slot, i) => ({
      id: PREFIXE_CRENEAU + i,
      title: tronquerTexte((etat.proposedSlotsLabels && etat.proposedSlotsLabels[i]) || String(i + 1), 20)
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
// Renvoie true si WhatsApp a accepte le message, false sinon (token/numero manquant, refus de Meta - par
// exemple texte libre hors de la fenetre de 24 h). Les appelants historiques l'ignorent ; les rappels de
// rendez-vous (Etape 44, voir envoyerRappel dans creerOptionsEngine) s'en servent pour reessayer.
async function envoyerMessageWhatsApp(destinataire, texte, phoneNumberId) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    console.error("WHATSAPP_TOKEN ou phone_number_id manquant — impossible d'envoyer la reponse.");
    return false;
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
    return false;
  }
  console.log("Reponse envoyee avec succes.");
  return true;
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

// Construit les `parameters` du composant "body" d'un template WhatsApp. `avecNoms=false` (ancien
// format, variables numerotees {{1}}/{{2}} cote Meta) omet `parameter_name` ; `avecNoms=true` (nouveau
// format, variables nommees {{nom_variable}}) l'ajoute - voir le commentaire sur `parametresNoms` au
// dessus de TEMPLATES_ALERTE_MARCHAND pour le contexte complet de ce changement cote Meta (27 sept 2026).
function construireParametresTemplate(parametresTexte, nomsParametres, avecNoms) {
  return parametresTexte.map((texte, i) => {
    const p = { type: "text", text: texte };
    if (avecNoms && nomsParametres && nomsParametres[i]) p.parameter_name = nomsParametres[i];
    return p;
  });
}

async function appelEnvoiTemplateWhatsApp(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte, nomsParametres, avecNoms) {
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
      type: "template",
      template: {
        name: nomTemplate,
        language: { code: langue },
        components: [
          { type: "body", parameters: construireParametresTemplate(parametresTexte, nomsParametres, avecNoms) },
        ],
      },
    }),
  });
  return reponse;
}

// --- Fonction utilitaire : envoyer un template WhatsApp approuve via l'API Cloud ---
// Retourne true si l'envoi a reussi, false sinon (permet a l'appelant de basculer sur un repli). Ne
// leve jamais d'exception : toute erreur (reseau, template inexistant/non approuve, etc.) est capturee,
// journalisee, et traduite en simple `false`.
//
// `nomsParametres` (optionnel, voir TEMPLATES_ALERTE_MARCHAND) : premier essai TOUJOURS sans
// `parameter_name` (ancien format, variables numerotees) ; si Meta le refuse ET que `nomsParametres` est
// fourni, on ressaie UNE fois avec `parameter_name` (nouveau format, variables nommees). Ainsi le meme
// code sert indifferemment les marchands dont le template a ete approuve avant ou apres le changement de
// format Meta du 27 sept 2026, sans avoir besoin de savoir a l'avance lequel s'applique.
async function envoyerTemplateWhatsApp(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte, nomsParametres) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    console.error("WHATSAPP_TOKEN ou phone_number_id manquant — impossible d'envoyer le template.");
    return false;
  }

  try {
    let reponse = await appelEnvoiTemplateWhatsApp(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte, nomsParametres, false);

    if (!reponse.ok && nomsParametres) {
      const detailEssai1 = await reponse.text();
      console.warn(`Envoi du template WhatsApp "${nomTemplate}" sans parameter_name refuse (${reponse.status}), nouvel essai avec noms :`, detailEssai1);
      reponse = await appelEnvoiTemplateWhatsApp(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte, nomsParametres, true);
    }

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

// --- Variantes "diagnostic" utilisees UNIQUEMENT par /api/marchands/:id/tester-alerte ci-dessus ---
// Identiques a envoyerTemplateWhatsApp/envoyerMessageWhatsApp ci-dessus (memes appels a l'API WhatsApp),
// mais renvoient le detail brut { ok, status, erreur } au lieu d'un simple booleen/rien - utile pour
// afficher l'erreur EXACTE renvoyee par Meta directement dans /admin, plutot que de forcer le marchand a
// aller chercher dans les logs serveur (qu'il ne consulte de toute facon pas). Le chemin de production
// (notifierMarchand ci-dessus) continue d'utiliser les fonctions d'origine, inchangees.
async function appelEnvoiTemplateWhatsAppDiag(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte, nomsParametres, avecNoms) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  const reponse = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: destinataire,
      type: "template",
      template: {
        name: nomTemplate,
        language: { code: langue },
        components: [
          { type: "body", parameters: construireParametresTemplate(parametresTexte, nomsParametres, avecNoms) },
        ],
      },
    }),
  });
  return reponse;
}

// nomsParametres est optionnel : passe par /api/marchands/:id/tester-alerte via TEMPLATES_ALERTE_MARCHAND.humain
// .parametresNoms, il permet a ce diagnostic de reproduire EXACTEMENT le meme repli "sans nom puis avec
// nom" que envoyerTemplateWhatsApp (voir plus haut) - sinon le bouton "Tester l'alerte" afficherait a tort
// une erreur de format alors que le vrai envoi (notifierMarchand), lui, reussirait au 2e essai.
async function envoyerTemplateWhatsAppDiag(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte, nomsParametres) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    return { ok: false, status: null, erreur: "WHATSAPP_TOKEN ou phone_number_id manquant sur le serveur." };
  }
  try {
    let reponse = await appelEnvoiTemplateWhatsAppDiag(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte, nomsParametres, false);
    let detailEssai1 = null;
    if (!reponse.ok && nomsParametres) {
      detailEssai1 = await reponse.text();
      reponse = await appelEnvoiTemplateWhatsAppDiag(destinataire, phoneNumberId, nomTemplate, langue, parametresTexte, nomsParametres, true);
    }
    if (!reponse.ok) {
      const detail = await reponse.text();
      return { ok: false, status: reponse.status, erreur: detailEssai1 ? `${detail} (1er essai sans nom : ${detailEssai1})` : detail };
    }
    return { ok: true, status: reponse.status, erreur: null };
  } catch (erreur) {
    return { ok: false, status: null, erreur: String((erreur && erreur.message) || erreur) };
  }
}

async function envoyerMessageWhatsAppDiag(destinataire, texte, phoneNumberId) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) {
    return { ok: false, status: null, erreur: "WHATSAPP_TOKEN ou phone_number_id manquant sur le serveur." };
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  try {
    const reponse = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: destinataire, type: "text", text: { body: texte } }),
    });
    if (!reponse.ok) {
      const detail = await reponse.text();
      return { ok: false, status: reponse.status, erreur: detail };
    }
    return { ok: true, status: reponse.status, erreur: null };
  } catch (erreur) {
    return { ok: false, status: null, erreur: String((erreur && erreur.message) || erreur) };
  }
}

// ---------------- Pont IzyFacture : tentatives de facturation/avoir (voir izyfacture.js) ----------------
// Regroupees ici (plutot qu'a cote de chaque route qui les appelle) car utilisees a la fois par le
// declenchement automatique (PUT .../statut ci-dessus), le reessai manuel (POST .../izyfacture/facturer
// ci-dessus) ET le passage periodique de reessai (voir plus bas) — une seule logique, jamais dupliquee.
// Jamais d'exception qui remonte a l'appelant : toute erreur est journalisee et enregistree sur la commande
// (izyfactureStatut/izyfactureErreur) plutot que de faire planter la requete ou le passage periodique.
//
// Etape 46 : ces fonctions servent AUSSI les rendez-vous honores du volet service. `order` designe alors un
// rendez-vous (meme schema de champs izyfacture*, voir conversationService.js) ; seul ce qui differe est
// isole dans les trois petits utilitaires ci-dessous, decides par le type du moteur du marchand.
function estRendezVous(entry) { return entry.engine.type === "service"; }
function libelleObjetFacture(entry, order) { return estRendezVous(entry) ? "le rendez-vous #" + order.id : "la commande #" + order.id; }
function refAffichageObjet(entry, order) { return (estRendezVous(entry) ? "RDV-" : "CMD-") + String(order.id).padStart(4, "0"); }
function appelFacturer(entry, cle, order) {
  return estRendezVous(entry)
    ? izyfacture.facturerRendezVous(cle, entry.merchant.id, order)
    : izyfacture.facturerCommande(cle, entry.merchant.id, order);
}

async function tenterFacturationCommande(entry, order, options) {
  // Etape 54 : la source de facturation (integree ou IzyFacture) est decidee par le super-administrateur ;
  // une commande deja facturee par le module integre reste geree par lui, meme apres une bascule.
  if (sourceDeLObjet(entry, order) === "interne") return tenterFacturationInterne(entry, order, options);
  if (!entry.merchant.izyfactureApiKey) return;
  // Un rendez-vous sans prix (service gratuit/prix 0) n'a rien a facturer : on le dit clairement plutot que
  // d'envoyer une facture a zero a IzyFacture (erreur non reessayable, visible dans /admin).
  if (estRendezVous(entry) && !(Number(order.prix) > 0)) {
    entry.engine.enregistrerEtatIzyFacture(order.id, {
      izyfactureStatut: "erreur",
      izyfactureErreur: "Prix du rendez-vous nul : rien à facturer."
    });
    return;
  }
  const cle = cryptoUtil.dechiffrer(entry.merchant.izyfactureApiKey);
  if (!cle) {
    entry.engine.enregistrerEtatIzyFacture(order.id, {
      izyfactureStatut: "erreur",
      izyfactureErreur: "Clé IzyFacture illisible (échec de déchiffrement) — réenregistrez-la depuis Paramètres."
    });
    return;
  }
  try {
    const reponse = await appelFacturer(entry, cle, order);
    entry.engine.enregistrerEtatIzyFacture(order.id, {
      izyfactureStatut: "facturee",
      izyfactureFactureId: reponse.invoice.id,
      izyfactureNumero: reponse.invoice.number,
      // reponse.invoice.verifyUrl : ajoute a la doc API-IZYVENDEUR.md le 28 sept 2026 - null si le marchand
      // n'a pas le volet "QR de verification" (formules Pro/Cabinet uniquement), jamais reconstruit ici.
      izyfactureUrlVerification: reponse.invoice.verifyUrl || null,
      izyfactureErreur: null
    });
    console.log(`[${entry.merchant.id}] Facture IzyFacture ${reponse.invoice.number} créée pour ${libelleObjetFacture(entry, order)}${reponse.duplicate ? " (déjà existante, aucun doublon)" : ""}.`);
    // Etape 57 : une vente POS facturee chez IzyFacture ne doit plus compter comme vente au comptant du journal intégré.
    if (order.source === "pos" && entry.facturation) entry.facturation.noterEvenementPos(order.id, "remplacee");
    // Notification client (doc, section 9 point 4) uniquement pour une facture NOUVELLEMENT creee
    // (reponse.duplicate === false) - un reessai manuel (bouton /admin) ou automatique sur une commande deja
    // facturee renvoie la meme facture (anti-doublon externalRef, voir izyfacture.js) et ne doit pas
    // renvoyer une deuxieme fois le meme message au client. Jamais bloquant : une erreur d'envoi n'affecte
    // pas la facturation elle-meme, deja acquise cote IzyFacture a ce stade.
    if (!reponse.duplicate) {
      try {
        await notifierClientFactureCreee(entry, order, reponse.invoice);
      } catch (erreurNotif) {
        console.error(`[${entry.merchant.id}] Échec de la notification client (facture créée, ${libelleObjetFacture(entry, order)}) :`, erreurNotif.message || erreurNotif);
      }
    }
  } catch (erreur) {
    entry.engine.enregistrerEtatIzyFacture(order.id, {
      izyfactureStatut: erreur.retryable ? "en_attente" : "erreur",
      izyfactureErreur: erreur.message || "Erreur IzyFacture inconnue"
    });
    console.error(`[${entry.merchant.id}] Échec de facturation IzyFacture (${libelleObjetFacture(entry, order)}, ${erreur.retryable ? "sera réessayé" : "non réessayable"}) :`, erreur.message, erreur.code || "");
  }
}

async function tenterAvoirCommande(entry, order, raison) {
  if (order.factureSource === "interne") return tenterAvoirInterne(entry, order, raison);
  if (!entry.merchant.izyfactureApiKey || !order.izyfactureFactureId) return;
  const cle = cryptoUtil.dechiffrer(entry.merchant.izyfactureApiKey);
  if (!cle) return;
  try {
    const reponse = await izyfacture.creerAvoirAnnulation(cle, order.izyfactureFactureId, raison || (estRendezVous(entry) ? "Rendez-vous annulé" : undefined));
    entry.engine.enregistrerEtatIzyFacture(order.id, {
      izyfactureStatut: "avoir",
      izyfactureAvoirNumero: reponse.creditNote.number,
      izyfactureErreur: null
    });
    console.log(`[${entry.merchant.id}] Avoir IzyFacture ${reponse.creditNote.number} créé pour ${estRendezVous(entry) ? "le rendez-vous annulé" : "la commande annulée"} #${order.id}.`);
  } catch (erreur) {
    // Pas de changement de izyfactureStatut ici : la facture reste valide chez IzyFacture (une commande
    // annulee dont l'avoir a echoue garde son statut "facturee" — le passage periodique ci-dessous la
    // reessaiera, voir DOIT_REESSAYER_AVOIR plus bas) plutot que de faire disparaitre silencieusement
    // l'echec ou de reintroduire un etat incoherent.
    console.error(`[${entry.merchant.id}] Échec de création d'avoir IzyFacture (${libelleObjetFacture(entry, order)}) :`, erreur.message, erreur.code || "");
  }
}

// Enregistre un paiement reçu sur une commande déjà facturée (bouton "Enregistrer un paiement", /admin
// onglet Commandes) - POST /invoices/{id}/payments côté IzyFacture (voir izyfacture.js, doc
// API-IZYVENDEUR.md section 5). Contrairement à tenterFacturationCommande/tenterAvoirCommande ci-dessus,
// les erreurs ne sont PAS avalées ici : c'est une action explicite du marchand qui attend un retour
// immédiat (voir la route qui l'appelle), pas un mécanisme de réessai automatique en arrière-plan - la
// route transforme l'exception en réponse HTTP claire.
async function enregistrerPaiementCommande(entry, order, { montant, methode, reference }) {
  if (order.factureSource === "interne") return enregistrerPaiementInterne(entry, order, { montant, methode, reference }, "pont");
  const cle = cryptoUtil.dechiffrer(entry.merchant.izyfactureApiKey);
  if (!cle) {
    const erreur = new Error("Clé IzyFacture illisible (échec de déchiffrement) — réenregistrez-la depuis Paramètres.");
    erreur.status = 400;
    throw erreur;
  }
  const reponse = await izyfacture.enregistrerPaiement(cle, order.izyfactureFactureId, {
    amount: montant,
    method: methode,
    ref: reference
  });
  // `receipt` (reçu numéroté créé pour ce paiement) documenté au niveau racine de la réponse depuis la mise
  // à jour du 28 sept 2026 de l'API-IZYVENDEUR.md - on lit aussi reponse.payment.receipt en repli, au cas où
  // une version antérieure d'IzyFacture le renverrait imbriqué (aucune des deux formes ne fait planter si
  // absente : numéroRecu reste simplement null).
  const recu = reponse.receipt || (reponse.payment && reponse.payment.receipt) || null;
  const historique = (order.izyfacturePaiements || []).concat([{
    montant,
    methode,
    reference: reference || null,
    date: new Date().toISOString(),
    recuNumero: recu ? recu.number : null
  }]);
  entry.engine.enregistrerEtatIzyFacture(order.id, {
    izyfactureFactureStatut: reponse.invoice ? reponse.invoice.status : null,
    izyfactureSolde: reponse.invoice ? reponse.invoice.balance : null,
    izyfactureRecuNumero: recu ? recu.number : (order.izyfactureRecuNumero || null),
    izyfacturePaiements: historique
  });
  console.log(`[${entry.merchant.id}] Paiement de ${montant} FCFA enregistré sur la facture ${order.izyfactureNumero || order.izyfactureFactureId} (${libelleObjetFacture(entry, order)})${recu ? `, reçu ${recu.number}` : ""}.`);
  // Notification client (voir doc, section 9 point 4) - à la différence des notifications de statut de
  // commande (fire-and-forget dans conversation.js), on l'attend ici : c'est une action ponctuelle voulue
  // par le marchand, mieux vaut qu'un échec soit visible dans les logs au bon moment plutôt que plus tard
  // sans lien évident avec ce paiement précis. Ne fait jamais échouer l'enregistrement du paiement lui-même
  // (déjà acquis côté IzyFacture à ce stade) si la notification échoue.
  try {
    await notifierClientPaiementRecu(entry, order, montant, recu ? recu.number : null);
  } catch (erreur) {
    console.error(`[${entry.merchant.id}] Échec de la notification client (paiement reçu, ${libelleObjetFacture(entry, order)}) :`, erreur.message || erreur);
  }
}

// Message WhatsApp au client après un paiement enregistré. Mêmes garde-fous que
// notifierChangementStatutCommande dans conversation.js : rien n'est envoyé à un numéro simulé/inconnu
// (order.fromWhatsapp absent, ou commande venue du Simulateur plutôt que d'un vrai client WhatsApp) -
// silencieusement, pas une erreur.
async function notifierClientPaiementRecu(entry, order, montant, numeroRecu) {
  if (!order.fromWhatsapp || order.source !== "whatsapp") return;
  const langue = order.langue === "en" ? "en" : "fr";
  const ref = refAffichageObjet(entry, order);
  const rdv = estRendezVous(entry);
  let texte = langue === "en"
    ? `Payment of ${sh.formatFcfa(montant)} received for your ${rdv ? "appointment" : "order"} ${ref}. Thank you!`
    : `Paiement de ${sh.formatFcfa(montant)} bien reçu pour votre ${rdv ? "rendez-vous" : "commande"} ${ref}. Merci !`;
  if (numeroRecu) {
    texte += langue === "en" ? ` Receipt No. ${numeroRecu}.` : ` Reçu n° ${numeroRecu}.`;
  }
  await envoyerMessageWhatsApp(order.fromWhatsapp, texte, entry.merchant.phoneNumberId);
}

// Message WhatsApp au client apres creation d'une facture IzyFacture (doc API-IZYVENDEUR.md, section 9
// point 4 : "Votre facture n° FAC-2026-0001 de 26 500 FCFA a été établie.") - appele par
// tenterFacturationCommande ci-dessus, uniquement pour une facture nouvellement creee (pas un retour
// "duplicate"). Memes garde-fous que notifierClientPaiementRecu ci-dessus : rien n'est envoye a un numero
// simule/inconnu (order.fromWhatsapp absent, ou commande venue du Simulateur plutot que d'un vrai client
// WhatsApp) - silencieusement, pas une erreur. Le lien de verification (invoice.verifyUrl, ajoute a la doc
// le 28 sept 2026) n'est ajoute au message que s'il est fourni par IzyFacture (reserve aux formules
// Pro/Cabinet avec le volet "QR de verification" active) - sinon le message se limite au numero et au
// montant, jamais de lien casse ou devine.
async function notifierClientFactureCreee(entry, order, invoice) {
  if (!order.fromWhatsapp || order.source !== "whatsapp") return;
  const langue = order.langue === "en" ? "en" : "fr";
  const montant = invoice && invoice.totals && typeof invoice.totals.ttc === "number" ? invoice.totals.ttc : null;
  const numero = (invoice && invoice.number) || "";
  let texte = langue === "en"
    ? `Your invoice No. ${numero}${montant !== null ? ` (${sh.formatFcfa(montant)})` : ""} has been issued.`
    : `Votre facture n° ${numero}${montant !== null ? ` de ${sh.formatFcfa(montant)}` : ""} a été établie.`;
  if (invoice && invoice.verifyUrl) {
    texte += langue === "en" ? ` Verify it here: ${invoice.verifyUrl}` : ` Vérifiez-la ici : ${invoice.verifyUrl}`;
  }
  await envoyerMessageWhatsApp(order.fromWhatsapp, texte, entry.merchant.phoneNumberId);
}

const PORT = process.env.PORT || 3000;

// ---------------- Reessai periodique des facturations IzyFacture en attente ----------------
// Complete le reessai immediat (au changement de statut) et le reessai manuel (bouton /admin) : une panne
// reseau ou une indisponibilite temporaire d'IzyFacture (5xx/429) marque la commande "en_attente" (voir
// tenterFacturationCommande) — ce passage la reessaie automatiquement, sans action du marchand, jusqu'a
// reussite. Volontairement un balayage periodique plutot que des minuteurs (5 s/30 s/5 min) par commande :
// un dyno Render peut redemarrer a tout moment (deploiement, veille) et perdrait un minuteur en memoire,
// alors qu'un balayage se represente de lui-meme au prochain demarrage — aucune tentative n'est jamais
// perdue, seulement retardee de quelques minutes au pire, ce qui reste tres largement dans l'esprit de la
// doc (section 9 : "réessayer plus tard", grace a externalRef jamais de risque de doublon).
const INTERVALLE_REESSAIS_IZYFACTURE_MS = 5 * 60 * 1000;

async function reessayerFacturationsIzyFactureEnAttente() {
  // Un marchand hybride (Etape 47) a deux moteurs : on balaie chacun, via sa vue (entry.engine = ce volet).
  const vues = [];
  for (const merchantId of Object.keys(engines)) {
    const complet = engines[merchantId];
    if (!complet) continue;
    Object.keys(complet.moteurs).forEach((t) => vues.push(vueEntree(complet, t)));
  }
  for (const entry of vues) {
    const merchantId = entry.merchant.id;
    // catalogue (commandes) ET service (rendez-vous honores, Etape 46)
    if (entry.merchant.actif === false) continue;
    if (!entry.merchant.optionFacturationIzyfacture || !entry.merchant.izyfactureApiKey) continue;
    if (entry.engine.type === "hebergement") continue; // Etape 66 : facturation des sejours
    const service = entry.engine.type === "service";
    let commandes;
    try {
      commandes = service ? entry.engine.getAppointments() : entry.engine.getOrders();
    } catch (erreur) {
      console.error(`[${merchantId}] Échec de lecture des commandes pour le réessai IzyFacture :`, erreur);
      continue;
    }
    for (const order of commandes) {
      if (order.izyfactureStatut === "en_attente") {
        // Un rendez-vous en attente de facturation mais repasse entre-temps a un autre statut que "Honoré"
        // (ex: annule) n'est plus a facturer.
        if (service && order.statut !== "Honoré" && !order.izyfactureFactureId) continue;
        await tenterFacturationCommande(entry, order);
      } else if (order.statut === (service ? "Annulé" : "Annulée") && order.izyfactureFactureId && order.izyfactureStatut === "facturee") {
        // Une commande deja facturee, annulee entre-temps, dont l'avoir avait echoue au premier essai (voir
        // le commentaire dans tenterAvoirCommande) - reessaye ici plutot que de rester bloquee.
        await tenterAvoirCommande(entry, order, order.raisonAnnulation);
      }
    }
  }
}

// ---------------- Rappel automatique la veille des rendez-vous (volet service) ----------------
// Toutes les 30 minutes (fenetre de declenchement de 4h cote conversationService.js - voir
// RAPPEL_DELAI_MIN_MS/MAX_MS - donc largement assez frequent pour ne rater aucun rendez-vous), on demande
// a chaque moteur "service" actif d'envoyer les rappels dus. Best-effort et independant par marchand :
// l'echec d'un marchand (ex: token WhatsApp expire) n'empeche jamais les autres d'etre traites.
const INTERVALLE_RAPPELS_MS = 30 * 60 * 1000;

async function envoyerRappelsPourTousLesMarchands() {
  for (const merchantId of Object.keys(engines)) {
    const entry = engines[merchantId];
    if (!entry || !entry.moteurs.service) continue; // volet rendez-vous d'un marchand service OU hybride
    if (entry.merchant.actif === false) continue; // marchand suspendu : pas de rappel envoye
    try {
      await entry.moteurs.service.envoyerRappelsDuJour();
    } catch (erreur) {
      console.error(`[${merchantId}] Echec de l'envoi des rappels de rendez-vous :`, erreur);
    }
  }
}

// Etape 72 : durees de vie des sessions de conversation sauvegardees (voir sessionsPersistantes.js). Toutes les 6 heures,
// chaque moteur applique ses regles (saisie intermediaire oubliee apres 24 h, panier apres 30 jours...) et la base
// supprime les sessions sans aucun message depuis 90 jours. Le journal des conversations n'est jamais touche.
const INTERVALLE_BALAYAGE_SESSIONS_MS = 6 * 60 * 60 * 1000;
async function balayerSessionsClients() {
  for (const merchantId of Object.keys(engines)) {
    const entry = engines[merchantId];
    if (!entry) continue;
    try {
      Object.keys(entry.moteurs || {}).forEach((v) => { if (entry.moteurs[v] && typeof entry.moteurs[v].balayerSessions === "function") entry.moteurs[v].balayerSessions(); });
      if (entry.routeur && typeof entry.routeur.balayerSessions === "function") entry.routeur.balayerSessions();
    } catch (erreur) {
      console.error(`[${merchantId}] Echec du balayage des sessions :`, erreur);
    }
  }
  try {
    const n = await db.purgerSessionsClients(90);
    if (n) console.log(`Sessions clients : ${n} session(s) sans activite depuis 90 jours supprimee(s).`);
  } catch (erreur) {
    console.error("Echec de la purge des sessions clients :", erreur);
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

  // Etape 72 : durees de vie des sessions sauvegardees (premier passage au demarrage, puis toutes les 6 heures).
  balayerSessionsClients().catch((erreur) => console.error("Echec du premier balayage des sessions :", erreur));
  setInterval(() => { balayerSessionsClients().catch((erreur) => console.error("Echec du balayage des sessions :", erreur)); }, INTERVALLE_BALAYAGE_SESSIONS_MS);

  // Meme principe pour le reessai des facturations IzyFacture en attente (voir plus haut).
  reessayerFacturationsIzyFactureEnAttente().catch((erreur) =>
    console.error("Echec du premier passage de reessai IzyFacture :", erreur)
  );
  setInterval(() => {
    reessayerFacturationsIzyFactureEnAttente().catch((erreur) =>
      console.error("Echec du passage periodique de reessai IzyFacture :", erreur)
    );
  }, INTERVALLE_REESSAIS_IZYFACTURE_MS);
}

// Etape 72 : a l'arret demande par Render (deploiement) ou par un Ctrl+C, on laisse finir les sauvegardes de sessions deja
// lancees (quelques millisecondes) avant de quitter, pour ne pas perdre le dernier message d'un client.
let arretEnCours = false;
async function arretPropre(signal) {
  if (arretEnCours) return;
  arretEnCours = true;
  console.log(`Signal ${signal} recu : fin des sauvegardes de sessions en cours...`);
  try {
    await Promise.race([require("./sessionsPersistantes").attendreEcritures(), new Promise((r) => setTimeout(r, 4000))]);
    db.viderSessionsFichier();
  } catch (e) { /* on quitte quand meme */ }
  process.exit(0);
}
process.on("SIGTERM", () => { arretPropre("SIGTERM"); });
process.on("SIGINT", () => { arretPropre("SIGINT"); });

demarrer().catch((erreur) => {
  console.error("Echec du demarrage du serveur :", erreur);
  process.exit(1);
});
