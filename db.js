// IzyVendeur - Couche de persistance
//
// Deux modes, choisis automatiquement selon la presence de la variable d'environnement DATABASE_URL :
//
//   - DATABASE_URL definie (production, Render) -> l'etat (catalogue + commandes + parametres) est
//     sauvegarde dans PostgreSQL, dans une table "app_state" (une ligne JSON par marchand). Contrairement
//     a un fichier local, ca survit aux redeploiements et aux redemarrages du service.
//
//   - DATABASE_URL absente (dev local, sans base installee) -> on retombe sur l'ancien comportement :
//     un fichier data.json a cote du serveur. Pratique pour tester rapidement en local sans avoir a
//     installer Postgres.
//
// Aujourd'hui il n'existe qu'un seul marchand (MERCHANT_KEY = "default"). Le jour du passage au
// multi-marchand, chaque marchand aura sa propre ligne (merchant_key = son phone_number_id par exemple) -
// le reste du code (conversation.js) n'aura pas a changer.

const fs = require("fs");
const path = require("path");
const { SEED_CATALOG, DEFAULT_AUTO_CONFIRM_MESSAGE } = require("./catalog");

const DATA_FILE = path.join(__dirname, "data.json");
const MERCHANT_KEY = "default";
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

function seedState() {
  return {
    catalog: JSON.parse(JSON.stringify(SEED_CATALOG)),
    orders: [],
    nextId: 1,
    settings: { autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE }
  };
}

// Charge l'etat au demarrage du serveur. Cree la table et l'insere si besoin (premiere fois).
async function initState() {
  if (pool) {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS app_state (" +
        "merchant_key TEXT PRIMARY KEY, " +
        "data JSONB NOT NULL, " +
        "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
      ")"
    );
    const res = await pool.query("SELECT data FROM app_state WHERE merchant_key = $1", [MERCHANT_KEY]);
    if (res.rows.length) {
      console.log("Etat charge depuis PostgreSQL (" + res.rows[0].data.orders.length + " commande(s)).");
      return res.rows[0].data;
    }
    const initial = seedState();
    await pool.query("INSERT INTO app_state (merchant_key, data) VALUES ($1, $2)", [MERCHANT_KEY, initial]);
    console.log("Nouvelle base PostgreSQL initialisee avec le catalogue de depart.");
    return initial;
  }

  // Pas de DATABASE_URL configuree -> comportement historique (fichier local, pour le dev).
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (parsed && parsed.catalog && parsed.orders) {
        if (!parsed.settings) parsed.settings = { autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE };
        console.log("Etat charge depuis data.json (mode local, DATABASE_URL non definie).");
        return parsed;
      }
    }
  } catch (erreur) {
    console.error("Erreur de lecture de data.json, on repart du catalogue de depart :", erreur);
  }
  console.log("Aucune base ni data.json trouve : demarrage avec le catalogue de depart (mode local).");
  return seedState();
}

// Sauvegarde l'etat courant. Appelee apres chaque changement (nouvelle commande, changement de statut...).
async function persist(state) {
  if (pool) {
    await pool.query(
      "INSERT INTO app_state (merchant_key, data, updated_at) VALUES ($1, $2, now()) " +
        "ON CONFLICT (merchant_key) DO UPDATE SET data = $2, updated_at = now()",
      [MERCHANT_KEY, state]
    );
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

module.exports = { initState, persist, usingDatabase: !!pool };
