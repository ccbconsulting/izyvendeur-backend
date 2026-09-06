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
const DATABASE_URL = process.env.DATABASE_URL;

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
    phoneNotification: null
  };
}

// A appeler une fois au demarrage. Retourne la liste des marchands connus (cree le marchand "default"
// s'il n'y en a encore aucun).
async function initRegistry() {
  if (pool) {
    await ensureMerchantsTable();
    const res = await pool.query("SELECT id, nom, type, phone_number_id, admin_user, admin_password, phone_notification FROM merchants ORDER BY created_at ASC");
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
    phoneNotification: row.phone_notification || null
  };
}

async function insertMerchant(m) {
  if (pool) {
    await ensureMerchantsTable();
    await pool.query(
      "INSERT INTO merchants (id, nom, type, phone_number_id, admin_user, admin_password, phone_notification) VALUES ($1,$2,$3,$4,$5,$6,$7) " +
        "ON CONFLICT (id) DO UPDATE SET nom=$2, type=$3, phone_number_id=$4, admin_user=$5, admin_password=$6, phone_notification=$7",
      [m.id, m.nom, m.type, m.phoneNumberId, m.adminUser, m.adminPassword, m.phoneNotification || null]
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
      "SELECT id, nom, type, phone_number_id, admin_user, admin_password, phone_notification FROM merchants WHERE id = $1",
      [id]
    );
    if (!res.rows.length) return null;
    const m = rowToMerchant(res.rows[0]);
    if (patch.adminUser !== undefined) m.adminUser = patch.adminUser;
    if (patch.adminPassword !== undefined) m.adminPassword = patch.adminPassword;
    if (patch.phoneNotification !== undefined) m.phoneNotification = patch.phoneNotification;
    await insertMerchant(m);
    return m;
  }

  const liste = fs.existsSync(MERCHANTS_FILE) ? JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8")) : [];
  const idx = liste.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  if (patch.adminUser !== undefined) liste[idx].adminUser = patch.adminUser;
  if (patch.adminPassword !== undefined) liste[idx].adminPassword = patch.adminPassword;
  if (patch.phoneNotification !== undefined) liste[idx].phoneNotification = patch.phoneNotification;
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(liste, null, 2));
  return liste[idx];
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

module.exports = {
  initRegistry,
  addMerchant,
  updateMerchantFields,
  initMerchantState,
  persistMerchantState,
  usingDatabase: !!pool
};
