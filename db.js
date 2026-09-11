// IzyVendeur - Couche de persistance (multi-marchand)
//
// Deux modes, choisis automatiquement selon la presence de la variable d'environnement DATABASE_URL :
//
//   - DATABASE_URL definie (production, Render) -> tout est sauvegarde dans PostgreSQL :
//       - table "merchants" : le REGISTRE des marchands (une ligne par marchand : id, nom, type,
//         phone_number_id WhatsApp, identifiants admin). C'est ce registre qui permet au webhook de
//         savoir, pour un message entrant, a quel marchand il appartient (via le phone_number_id que
//         Meta indique toujours dans la charge utile).
//       - table "app_state" : une ligne JSON par marchand (meme cle "merchant_key" que son id dans le
//         registre) contenant ses donnees propres (catalogue+commandes pour un marchand "catalogue",
//         services+rendez-vous pour un marchand "service").
//
//   - DATABASE_URL absente (dev local) -> deux fichiers a cote du serveur : merchants.json (registre) et
//     data.json (etat, un objet par merchant_key a l'interieur). Pratique pour tester sans Postgres.
//
// Avant le passage au multi-marchand, un seul marchand existait ("default", type catalogue, branche sur
// les variables d'environnement PHONE_NUMBER_ID/WHATSAPP_TOKEN historiques). Au demarrage, si le registre
// est vide, on le recree automatiquement a partir de ces variables pour ne rien casser en production.

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");
const MERCHANTS_FILE = path.join(__dirname, "merchants.json");
const CONVERSATION_LOG_FILE = path.join(__dirname, "conversation-log.json");
const DATABASE_URL = process.env.DATABASE_URL;

// Nombre max de messages conserves PAR client (au-dela, les plus anciens sont abandonnes) - evite une
// croissance illimitee pour un client tres bavard sur le tres long terme, tout en couvrant tres largement
// l'historique utile pour un marchand qui consulte une conversation.
const MAX_MESSAGES_PAR_CLIENT = 500;

let pool = null;
if (DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Render exige une connexion SSL ; son certificat n'est pas signe par une autorite standard,
    // donc on desactive la verification stricte (comportement recommande par Render pour "pg").
    ssl: { rejectUnauthorized: false }
  });
}

// ---------------- Registre des marchands ----------------

async function ensureMerchantsTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS merchants (" +
      "id TEXT PRIMARY KEY, " +
      "nom TEXT NOT NULL, " +
      "type TEXT NOT NULL, " + // 'catalogue' ou 'service'
      "phone_number_id TEXT UNIQUE, " +
      "admin_user TEXT, " +
      "admin_password TEXT, " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
    ")"
  );
  // Migration : ajoute la colonne si la table existait deja avant son introduction (installations en
  // production). Sans effet si elle existe deja.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS phone_notification TEXT");
  // Suspension d'un marchand (ex: facture impayee) : coupe ses reponses automatiques sans toucher a ses
  // donnees. Actif par defaut pour ne suspendre personne au moment de la migration.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS actif BOOLEAN NOT NULL DEFAULT true");
}

function defaultMerchantFromEnv() {
  // Migration automatique : recree le marchand historique "default" a partir des variables
  // d'environnement existantes, pour que les installations deja en production ne perdent rien.
  return {
    id: "default",
    nom: "Marchand par defaut",
    type: "catalogue",
    phoneNumberId: process.env.PHONE_NUMBER_ID || null,
    adminUser: process.env.ADMIN_USER || "admin",
    adminPassword: process.env.ADMIN_PASSWORD || null,
    phoneNotification: null,
    actif: true
  };
}

// A appeler une fois au demarrage. Retourne la liste des marchands connus (cree le marchand "default"
// s'il n'y en a encore aucun).
async function initRegistry() {
  if (pool) {
    await ensureMerchantsTable();
    const res = await pool.query("SELECT id, nom, type, phone_number_id, admin_user, admin_password, phone_notification, actif FROM merchants ORDER BY created_at ASC");
    if (res.rows.length) {
      return res.rows.map(rowToMerchant);
    }
    const initial = defaultMerchantFromEnv();
    await insertMerchant(initial);
    console.log("Registre des marchands initialise avec le marchand par defaut (migration automatique).");
    return [initial];
  }

  try {
    if (fs.existsSync(MERCHANTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8"));
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (erreur) {
    console.error("Erreur de lecture de merchants.json, on repart du registre par defaut :", erreur);
  }
  const initial = [defaultMerchantFromEnv()];
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(initial, null, 2));
  return initial;
}

function rowToMerchant(row) {
  return {
    id: row.id,
    nom: row.nom,
    type: row.type,
    phoneNumberId: row.phone_number_id,
    adminUser: row.admin_user,
    adminPassword: row.admin_password,
    phoneNotification: row.phone_notification || null,
    actif: row.actif !== false
  };
}

async function insertMerchant(m) {
  if (pool) {
    await ensureMerchantsTable();
    await pool.query(
      "INSERT INTO merchants (id, nom, type, phone_number_id, admin_user, admin_password, phone_notification, actif) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) " +
        "ON CONFLICT (id) DO UPDATE SET nom=$2, type=$3, phone_number_id=$4, admin_user=$5, admin_password=$6, phone_notification=$7, actif=$8",
      [m.id, m.nom, m.type, m.phoneNumberId, m.adminUser, m.adminPassword, m.phoneNotification || null, m.actif !== false]
    );
    return;
  }
  const liste = fs.existsSync(MERCHANTS_FILE) ? JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8")) : [];
  const idx = liste.findIndex((x) => x.id === m.id);
  if (idx === -1) liste.push(m); else liste[idx] = m;
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(liste, null, 2));
}

// Ajoute un nouveau marchand au registre (utilise lors de l'onboarding manuel d'un nouveau marchand).
async function addMerchant(m) {
  await insertMerchant(m);
  return m;
}

// Met a jour un ou plusieurs champs (identifiants de connexion et/ou numero de notification personnel)
// d'UN marchand existant, sans toucher a ses autres champs (nom, type, phone_number_id). Utilise pour :
// la creation d'un mot de passe initial par le super-administrateur, la reinitialisation d'un mot de
// passe oublie, le changement de mot de passe par le marchand lui-meme, et la configuration du numero de
// notification (celui qui recoit un message WhatsApp quand un client demande a parler a un humain).
// Retourne le marchand mis a jour, ou null s'il n'existe pas.
async function updateMerchantFields(id, patch) {
  if (pool) {
    await ensureMerchantsTable();
    const res = await pool.query(
      "SELECT id, nom, type, phone_number_id, admin_user, admin_password, phone_notification, actif FROM merchants WHERE id = $1",
      [id]
    );
    if (!res.rows.length) return null;
    const m = rowToMerchant(res.rows[0]);
    if (patch.adminUser !== undefined) m.adminUser = patch.adminUser;
    if (patch.adminPassword !== undefined) m.adminPassword = patch.adminPassword;
    if (patch.phoneNotification !== undefined) m.phoneNotification = patch.phoneNotification;
    if (patch.actif !== undefined) m.actif = !!patch.actif;
    // NOUVEAU : nom affiche et phone_number_id WhatsApp corrigeables apres coup (ex: faute de frappe a la
    // creation). Volontairement PAS "id" ni "type" ici : "id" sert de cle a tout l'etat deja persiste
    // (app_state, journal des conversations) et de cle aux sessions/moteurs EN MEMOIRE — le changer
    // orphelinerait tout l'historique existant sans un vrai outil de migration. "type" determine quel
    // moteur de conversation (catalogue/service) tourne, avec une forme d'etat totalement differente : le
    // changer casserait la lecture de l'etat deja enregistre. Si l'un ou l'autre est errone, il est plus
    // sur de supprimer ce marchand (voir deleteMerchant) et d'en recreer un avec les bonnes valeurs.
    if (patch.nom !== undefined) m.nom = patch.nom;
    if (patch.phoneNumberId !== undefined) m.phoneNumberId = patch.phoneNumberId || null;
    await insertMerchant(m);
    return m;
  }

  const liste = fs.existsSync(MERCHANTS_FILE) ? JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8")) : [];
  const idx = liste.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  if (patch.adminUser !== undefined) liste[idx].adminUser = patch.adminUser;
  if (patch.adminPassword !== undefined) liste[idx].adminPassword = patch.adminPassword;
  if (patch.phoneNotification !== undefined) liste[idx].phoneNotification = patch.phoneNotification;
  if (patch.actif !== undefined) liste[idx].actif = !!patch.actif;
  if (patch.nom !== undefined) liste[idx].nom = patch.nom;
  if (patch.phoneNumberId !== undefined) liste[idx].phoneNumberId = patch.phoneNumberId || null;
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(liste, null, 2));
  return liste[idx];
}

// Supprime DEFINITIVEMENT un marchand du registre (utilise quand il a ete cree par erreur - ex: mauvais
// "id" ou mauvais type, deux champs volontairement non modifiables ci-dessus - ou quand le marchand quitte
// IzyVendeur). Ne touche PAS a son etat deja enregistre (app_state) ni a son journal de conversations : ces
// donnees restent en base, simplement orphelines (rattachees a un merchant_key qui n'a plus de ligne dans
// "merchants"), ce qui les rend inaccessibles depuis /admin sans jamais les effacer completement - un
// compromis volontairement prudent plutot qu'une suppression en cascade irreversible. Pour un marchand qui
// ne paie plus mais dont on veut garder l'historique, preferer la suspension (updateMerchantFields avec
// {actif:false}) a cette suppression. Retourne true si une ligne a bien ete supprimee, false si ce
// marchand n'existait deja pas.
async function deleteMerchant(id) {
  if (pool) {
    await ensureMerchantsTable();
    const res = await pool.query("DELETE FROM merchants WHERE id = $1", [id]);
    return res.rowCount > 0;
  }
  const liste = fs.existsSync(MERCHANTS_FILE) ? JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8")) : [];
  const idx = liste.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  liste.splice(idx, 1);
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(liste, null, 2));
  return true;
}

// ---------------- Etat d'un marchand (catalogue+commandes, ou services+rendez-vous) ----------------

async function ensureAppStateTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS app_state (" +
      "merchant_key TEXT PRIMARY KEY, " +
      "data JSONB NOT NULL, " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
    ")"
  );
}

// Charge l'etat d'UN marchand (identifie par sa cle = son id dans le registre). `seedFn` fournit l'etat
// de depart si ce marchand n'a encore jamais ete sauvegarde.
async function initMerchantState(merchantKey, seedFn) {
  if (pool) {
    await ensureAppStateTable();
    const res = await pool.query("SELECT data FROM app_state WHERE merchant_key = $1", [merchantKey]);
    if (res.rows.length) {
      console.log("Etat du marchand '" + merchantKey + "' charge depuis PostgreSQL.");
      return res.rows[0].data;
    }
    const initial = seedFn();
    await pool.query("INSERT INTO app_state (merchant_key, data) VALUES ($1, $2)", [merchantKey, initial]);
    console.log("Nouvel etat PostgreSQL initialise pour le marchand '" + merchantKey + "'.");
    return initial;
  }

  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (parsed && parsed[merchantKey]) {
        console.log("Etat du marchand '" + merchantKey + "' charge depuis data.json (mode local).");
        return parsed[merchantKey];
      }
    }
  } catch (erreur) {
    console.error("Erreur de lecture de data.json, on repart de l'etat de depart pour '" + merchantKey + "' :", erreur);
  }
  console.log("Aucun etat existant pour '" + merchantKey + "' : demarrage avec l'etat de depart (mode local).");
  return seedFn();
}

// Sauvegarde l'etat courant d'UN marchand.
async function persistMerchantState(merchantKey, state) {
  if (pool) {
    await ensureAppStateTable();
    await pool.query(
      "INSERT INTO app_state (merchant_key, data, updated_at) VALUES ($1, $2, now()) " +
        "ON CONFLICT (merchant_key) DO UPDATE SET data = $2, updated_at = now()",
      [merchantKey, state]
    );
    return;
  }
  let toutEtats = {};
  if (fs.existsSync(DATA_FILE)) {
    try { toutEtats = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) || {}; } catch (e) { toutEtats = {}; }
  }
  toutEtats[merchantKey] = state;
  fs.writeFileSync(DATA_FILE, JSON.stringify(toutEtats, null, 2));
}

// ---------------- Journal complet des conversations (client <-> bot/marchand) ----------------
//
// Contrairement a `conversationsHumain` (memoire seulement, dans shared.js - juste pour la mise en
// relation avec un humain), ce journal garde TOUS les echanges, durablement, pour que le marchand puisse
// consulter depuis /admin ce que le bot a dit a un client donne, meme des mois plus tard. Une ligne par
// message ; `de` vaut "client", "bot" (reponse automatique) ou "marchand" (reponse manuelle envoyee depuis
// /admin, onglet Conversations).

async function ensureConversationLogTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS conversation_log (" +
      "id SERIAL PRIMARY KEY, " +
      "merchant_key TEXT NOT NULL, " +
      "telephone TEXT NOT NULL, " +
      "de TEXT NOT NULL, " + // 'client' | 'bot' | 'marchand'
      "texte TEXT NOT NULL, " +
      "horodatage TIMESTAMPTZ NOT NULL DEFAULT now()" +
    ")"
  );
  await pool.query("CREATE INDEX IF NOT EXISTS idx_conversation_log_marchand_tel ON conversation_log (merchant_key, telephone, horodatage)");
}

function lireJournalLocal() {
  try {
    if (fs.existsSync(CONVERSATION_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(CONVERSATION_LOG_FILE, "utf8")) || {};
    }
  } catch (erreur) {
    console.error("Erreur de lecture de conversation-log.json, on repart d'un journal vide :", erreur);
  }
  return {};
}

// Enregistre un message. Jamais bloquant pour l'appelant en cas d'echec : la conversation elle-meme (le
// message envoye au client) ne doit jamais dependre de la reussite de cette ecriture - voir les
// appels cote conversation.js/conversationService.js (fire-and-forget, avec `.catch(console.error)`).
async function logConversationMessage(merchantKey, telephone, de, texte) {
  if (!telephone || !texte) return;
  if (pool) {
    await ensureConversationLogTable();
    await pool.query(
      "INSERT INTO conversation_log (merchant_key, telephone, de, texte) VALUES ($1, $2, $3, $4)",
      [merchantKey, telephone, de, String(texte).slice(0, 4000)]
    );
    return;
  }
  const journal = lireJournalLocal();
  if (!journal[merchantKey]) journal[merchantKey] = {};
  if (!journal[merchantKey][telephone]) journal[merchantKey][telephone] = [];
  journal[merchantKey][telephone].push({ de, texte: String(texte).slice(0, 4000), horodatageISO: new Date().toISOString() });
  if (journal[merchantKey][telephone].length > MAX_MESSAGES_PAR_CLIENT) {
    journal[merchantKey][telephone] = journal[merchantKey][telephone].slice(-MAX_MESSAGES_PAR_CLIENT);
  }
  fs.writeFileSync(CONVERSATION_LOG_FILE, JSON.stringify(journal, null, 2));
}

// Un resume par client (telephone, dernier message, date du dernier echange, nombre total de messages),
// trie du plus recent au plus ancien - utilise pour la liste "Historique des conversations" de /admin.
async function getConversationSummaries(merchantKey) {
  if (pool) {
    await ensureConversationLogTable();
    const compteurs = await pool.query(
      "SELECT telephone, COUNT(*) AS nombre, MAX(horodatage) AS dernier_horodatage " +
      "FROM conversation_log WHERE merchant_key = $1 GROUP BY telephone",
      [merchantKey]
    );
    const derniers = await pool.query(
      "SELECT DISTINCT ON (telephone) telephone, de, texte, horodatage " +
      "FROM conversation_log WHERE merchant_key = $1 ORDER BY telephone, horodatage DESC",
      [merchantKey]
    );
    const parTelephone = {};
    derniers.rows.forEach((r) => { parTelephone[r.telephone] = r; });
    return compteurs.rows
      .map((c) => {
        const dernier = parTelephone[c.telephone] || {};
        return {
          telephone: c.telephone,
          nombreMessages: Number(c.nombre),
          dernierHorodatageISO: new Date(c.dernier_horodatage).toISOString(),
          dernierDe: dernier.de || null,
          dernierMessage: dernier.texte || null
        };
      })
      .sort((a, b) => new Date(b.dernierHorodatageISO) - new Date(a.dernierHorodatageISO));
  }

  const journal = lireJournalLocal()[merchantKey] || {};
  return Object.keys(journal)
    .map((telephone) => {
      const messages = journal[telephone];
      const dernier = messages[messages.length - 1];
      return {
        telephone,
        nombreMessages: messages.length,
        dernierHorodatageISO: dernier ? dernier.horodatageISO : null,
        dernierDe: dernier ? dernier.de : null,
        dernierMessage: dernier ? dernier.texte : null
      };
    })
    .sort((a, b) => new Date(b.dernierHorodatageISO) - new Date(a.dernierHorodatageISO));
}

// Historique complet (borne a MAX_MESSAGES_PAR_CLIENT) d'UN client, du plus ancien au plus recent - pret a
// afficher tel quel dans une fenetre de discussion.
async function getConversationHistory(merchantKey, telephone) {
  if (pool) {
    await ensureConversationLogTable();
    const res = await pool.query(
      "SELECT de, texte, horodatage FROM conversation_log WHERE merchant_key = $1 AND telephone = $2 " +
      "ORDER BY horodatage DESC LIMIT $3",
      [merchantKey, telephone, MAX_MESSAGES_PAR_CLIENT]
    );
    return res.rows.reverse().map((r) => ({ de: r.de, texte: r.texte, horodatageISO: new Date(r.horodatage).toISOString() }));
  }
  const journal = lireJournalLocal();
  return ((journal[merchantKey] || {})[telephone] || []).slice();
}

module.exports = {
  initRegistry,
  addMerchant,
  updateMerchantFields,
  deleteMerchant,
  initMerchantState,
  persistMerchantState,
  logConversationMessage,
  getConversationSummaries,
  getConversationHistory,
  usingDatabase: !!pool
};
