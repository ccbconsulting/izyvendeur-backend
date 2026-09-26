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
  // Comptes "employe" d'un marchand : chacun a son propre identifiant/mot de passe et une liste de roles
  // (voir ROLES_EMPLOYE_VALIDES dans server.js) qui limite les onglets/actions auxquels il a acces, par
  // opposition au compte principal du marchand (adminUser/adminPassword) qui a toujours acces a tout ce
  // qui concerne SON marchand. Tableau vide par defaut : aucun marchand existant n'a d'employe tant qu'il
  // n'en cree pas depuis /admin.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS employes JSONB NOT NULL DEFAULT '[]'::jsonb");
  // Logo du marchand (URL hebergee sur Cloudflare R2, voir storage.js) - facultatif, NULL par defaut.
  // Affiche UNIQUEMENT dans /admin (en-tete) - identite de marque stable du marchand. Voir
  // image_accueil_whatsapp_url ci-dessous pour l'image envoyee cote client WhatsApp : deux emplacements
  // volontairement INDEPENDANTS (aucun repli de l'un vers l'autre), pour qu'un marchand puisse garder un
  // logo officiel stable dans /admin tout en changeant librement l'image d'accueil WhatsApp au gre de ses
  // promotions (flyers, offres du moment...) sans jamais toucher a son logo.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS logo_url TEXT");
  // Image envoyee par le bot en tout premier (avant le message de bienvenue bilingue), au tout premier
  // message d'un nouveau contact WhatsApp - voir server.js. Facultatif, NULL par defaut : un marchand qui
  // ne la configure pas ne voit RIEN de nouveau (pas de repli automatique sur logo_url, voir commentaire
  // ci-dessus).
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS image_accueil_whatsapp_url TEXT");
  // Numero WhatsApp "affichable" du marchand (celui que ses clients contactent reellement, au format
  // international avec indicatif pays - ex: 237677123456), distinct du phone_number_id technique (l'ID
  // interne Meta utilise pour appeler l'API, illisible et inutilisable pour construire un lien). Sert
  // UNIQUEMENT a generer les liens de commande wa.me par article (voir /api/.../lien-commande dans
  // server.js) - facultatif, NULL par defaut, aucun impact sur l'envoi/reception de messages.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS numero_whatsapp_public TEXT");
  // Options payantes (demandees le 15 septembre 2026) : "Stock illimite" (case a cocher par article, voir
  // conversation.js/virtualStock) et "Lien de commande" (numero WhatsApp public + bouton "Copier le lien"
  // par article, voir server.js) n'etaient au depart accessibles a tous les marchands sans distinction —
  // desormais reservees, chacune independamment, aux marchands pour qui LE SUPER-ADMINISTRATEUR les a
  // explicitement debloquees (voir PUT /api/marchands/:id/options-payantes). Faux par defaut : aucun
  // marchand existant n'y a acces tant qu'il n'est pas explicitement debloque.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS option_stock_illimite BOOLEAN NOT NULL DEFAULT false");
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS option_lien_commande BOOLEAN NOT NULL DEFAULT false");
  // "Notifications de statut" (demandee le 16 septembre 2026) : le marchand peut faire envoyer un message
  // WhatsApp automatique au CLIENT quand une commande passe a Commandee/Expediee/Livree/Annulee (statuts et
  // textes reglables individuellement dans Parametres - voir conversation.js) - meme principe d'option
  // payante que les deux precedentes, reservee aux marchands debloques par le super-administrateur.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS option_notifications_statut BOOLEAN NOT NULL DEFAULT false");
  // Cles des migrations de roles employe (voir migrerRolesEmployes plus bas) deja appliquees a ce marchand -
  // vide par defaut (aucune migration encore appliquee). CHAQUE cle n'est appliquee QU'UNE SEULE FOIS par
  // marchand, jamais reappliquee ensuite meme si un employe n'a plus le role migre : sans cette colonne, la
  // migration (basee uniquement sur les roles actuels d'un employe) se represente a chaque redemarrage du
  // serveur et re-ajouterait silencieusement un role qu'un marchand aurait volontairement retire a un
  // employe apres coup - ce qui viderait de son sens l'independance nouvellement introduite entre ces roles.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS roles_migres JSONB NOT NULL DEFAULT '[]'::jsonb");
  // Pont IzyFacture (25 septembre 2026) : cle d'API IzyFacture du marchand, stockee CHIFFREE (voir
  // crypto-util.js - jamais en clair en base) et bascule "creer automatiquement les factures". NULL/false
  // par defaut : aucun marchand existant n'a la facturation automatique active tant qu'il n'a pas lui-meme
  // enregistre sa cle depuis /admin.
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS izyfacture_api_key TEXT");
  await pool.query("ALTER TABLE merchants ADD COLUMN IF NOT EXISTS izyfacture_auto_facturation BOOLEAN NOT NULL DEFAULT false");
}

// Cles de migration connues pour les roles employe (voir migrerRolesEmployes ci-dessous). Un marchand cree
// APRES l'introduction de ces migrations (voir POST /api/marchands dans server.js) n'a jamais connu
// l'ancien regroupement de roles - il est cree directement avec toutes ces cles deja marquees "appliquees",
// pour qu'un de ses employes puisse avoir par exemple "tableaudebord" sans "rapports" des le depart, sans
// qu'un redemarrage ulterieur du serveur ne revienne dessus.
const CLES_MIGRATIONS_ROLES_CONNUES = [
  "commandes_depuis_conversations",
  "tableaudebord_depuis_parametres",
  "rapports_depuis_tableaudebord",
  "inventaire_depuis_rapports"
];

// Migrations ponctuelles (25 septembre 2026) sur les roles employe (voir ROLES_EMPLOYE_VALIDES dans
// server.js) : des roles autrefois regroupes avec un autre deviennent independants, et on ajoute
// automatiquement le nouveau role a tout employe qui beneficiait deja de l'acces via l'ancien
// regroupement, pour ne retirer d'acces a personne au moment du changement.
//   - "commandes" : jusque-la rattache au role "conversations" (marchands catalogue uniquement).
//   - "tableaudebord" : jusque-la rattache au role "parametres" (Tableau de bord commun aux deux types de
//     marchand).
//   - "rapports" : jusque-la rattache au role "tableaudebord" (Rapports et Inventaire, marchand catalogue
//     uniquement).
//   - "inventaire" : jusque-la rattache au role "rapports" (l'onglet unique "Rapports" scinde en deux,
//     marchand catalogue uniquement).
// IMPORTANT : chaque cle de migration ne s'applique QU'UNE SEULE FOIS par marchand (voir roles_migres,
// ensureMerchantsTable) - une fois marquee, elle n'est plus jamais reappliquee, meme a un futur
// redemarrage du serveur. Sans ca, un marchand qui retirerait volontairement "rapports" a un employe ayant
// gardé "tableaudebord" se le verrait silencieusement rendre au prochain redemarrage : la migration se
// re-representerait indefiniment puisqu'elle ne fait que regarder les roles ACTUELS de l'employe, sans se
// souvenir qu'elle a deja fait son travail une fois. Les quatre cles sont verifiees DANS L'ORDRE pour
// chaque marchand a sa toute premiere migration (parametres -> tableaudebord d'abord, PUIS tableaudebord ->
// rapports, PUIS rapports -> inventaire juste apres, sur le tableau de roles deja mis a jour a chaque
// etape) : un employe qui n'a jamais eu que "parametres" recoit donc bien "tableaudebord", "rapports" ET
// "inventaire" en une seule passe, meme si ce marchand n'a jamais ete migre auparavant.
// Mute et persiste directement les marchands concernes (un seul insertMerchant meme si plusieurs cles
// s'appliquent au meme marchand), puis retourne la liste (inchangee dans son contenu, sauf les roles et
// roles_migres migres).
async function migrerRolesEmployes(marchands) {
  for (const m of marchands) {
    const dejaAppliquees = new Set(Array.isArray(m.rolesMigres) ? m.rolesMigres : []);
    let modifie = false;

    if (!dejaAppliquees.has("commandes_depuis_conversations")) {
      if (m.type === "catalogue" && Array.isArray(m.employes)) {
        for (const emp of m.employes) {
          if (Array.isArray(emp.roles) && emp.roles.indexOf("conversations") !== -1 && emp.roles.indexOf("commandes") === -1) {
            emp.roles.push("commandes");
          }
        }
      }
      dejaAppliquees.add("commandes_depuis_conversations");
      modifie = true;
    }

    if (!dejaAppliquees.has("tableaudebord_depuis_parametres")) {
      if (Array.isArray(m.employes)) {
        for (const emp of m.employes) {
          if (Array.isArray(emp.roles) && emp.roles.indexOf("parametres") !== -1 && emp.roles.indexOf("tableaudebord") === -1) {
            emp.roles.push("tableaudebord");
          }
        }
      }
      dejaAppliquees.add("tableaudebord_depuis_parametres");
      modifie = true;
    }

    if (!dejaAppliquees.has("rapports_depuis_tableaudebord")) {
      if (m.type === "catalogue" && Array.isArray(m.employes)) {
        for (const emp of m.employes) {
          if (Array.isArray(emp.roles) && emp.roles.indexOf("tableaudebord") !== -1 && emp.roles.indexOf("rapports") === -1) {
            emp.roles.push("rapports");
          }
        }
      }
      dejaAppliquees.add("rapports_depuis_tableaudebord");
      modifie = true;
    }

    if (!dejaAppliquees.has("inventaire_depuis_rapports")) {
      if (m.type === "catalogue" && Array.isArray(m.employes)) {
        for (const emp of m.employes) {
          if (Array.isArray(emp.roles) && emp.roles.indexOf("rapports") !== -1 && emp.roles.indexOf("inventaire") === -1) {
            emp.roles.push("inventaire");
          }
        }
      }
      dejaAppliquees.add("inventaire_depuis_rapports");
      modifie = true;
    }

    if (modifie) {
      m.rolesMigres = Array.from(dejaAppliquees);
      await insertMerchant(m);
    }
  }
  return marchands;
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
    actif: true,
    employes: [],
    logoUrl: null,
    imageAccueilWhatsappUrl: null,
    numeroWhatsappPublic: null,
    optionStockIllimite: false,
    optionLienCommande: false,
    optionNotificationsStatut: false,
    // Marchand HISTORIQUE (pas nouvellement cree) : contrairement a un marchand cree via l'API (voir
    // insertMerchant), on ne suppose rien - il peut deja avoir des employes avec d'anciens roles regroupes,
    // donc [] (a migrer normalement) plutot que CLES_MIGRATIONS_ROLES_CONNUES.
    rolesMigres: [],
    izyfactureApiKey: null,
    izyfactureAutoFacturation: false
  };
}

// A appeler une fois au demarrage. Retourne la liste des marchands connus (cree le marchand "default"
// s'il n'y en a encore aucun).
async function initRegistry() {
  if (pool) {
    await ensureMerchantsTable();
    const res = await pool.query("SELECT id, nom, type, phone_number_id, admin_user, admin_password, phone_notification, actif, employes, logo_url, image_accueil_whatsapp_url, numero_whatsapp_public, option_stock_illimite, option_lien_commande, option_notifications_statut, roles_migres, izyfacture_api_key, izyfacture_auto_facturation FROM merchants ORDER BY created_at ASC");
    if (res.rows.length) {
      return migrerRolesEmployes(res.rows.map(rowToMerchant));
    }
    const initial = defaultMerchantFromEnv();
    await insertMerchant(initial);
    console.log("Registre des marchands initialise avec le marchand par defaut (migration automatique).");
    return [initial];
  }

  try {
    if (fs.existsSync(MERCHANTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8"));
      if (Array.isArray(parsed) && parsed.length) return migrerRolesEmployes(parsed);
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
    actif: row.actif !== false,
    employes: Array.isArray(row.employes) ? row.employes : [],
    logoUrl: row.logo_url || null,
    imageAccueilWhatsappUrl: row.image_accueil_whatsapp_url || null,
    numeroWhatsappPublic: row.numero_whatsapp_public || null,
    optionStockIllimite: row.option_stock_illimite === true,
    optionLienCommande: row.option_lien_commande === true,
    optionNotificationsStatut: row.option_notifications_statut === true,
    rolesMigres: Array.isArray(row.roles_migres) ? row.roles_migres : [],
    izyfactureApiKey: row.izyfacture_api_key || null,
    izyfactureAutoFacturation: row.izyfacture_auto_facturation === true
  };
}

async function insertMerchant(m) {
  if (pool) {
    await ensureMerchantsTable();
    await pool.query(
      "INSERT INTO merchants (id, nom, type, phone_number_id, admin_user, admin_password, phone_notification, actif, employes, logo_url, image_accueil_whatsapp_url, numero_whatsapp_public, option_stock_illimite, option_lien_commande, option_notifications_statut, roles_migres, izyfacture_api_key, izyfacture_auto_facturation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18) " +
        "ON CONFLICT (id) DO UPDATE SET nom=$2, type=$3, phone_number_id=$4, admin_user=$5, admin_password=$6, phone_notification=$7, actif=$8, employes=$9::jsonb, logo_url=$10, image_accueil_whatsapp_url=$11, numero_whatsapp_public=$12, option_stock_illimite=$13, option_lien_commande=$14, option_notifications_statut=$15, roles_migres=$16::jsonb, izyfacture_api_key=$17, izyfacture_auto_facturation=$18",
      // rolesMigres absent (nouveau marchand cree via l'API, voir server.js POST /api/marchands) -> on
      // suppose qu'il n'a jamais connu l'ancien regroupement de roles, donc toutes les cles de migration
      // connues sont deja "appliquees" par defaut (rien a migrer pour un marchand qui vient de naitre).
      [m.id, m.nom, m.type, m.phoneNumberId, m.adminUser, m.adminPassword, m.phoneNotification || null, m.actif !== false, JSON.stringify(m.employes || []), m.logoUrl || null, m.imageAccueilWhatsappUrl || null, m.numeroWhatsappPublic || null, !!m.optionStockIllimite, !!m.optionLienCommande, !!m.optionNotificationsStatut, JSON.stringify(Array.isArray(m.rolesMigres) ? m.rolesMigres : CLES_MIGRATIONS_ROLES_CONNUES), m.izyfactureApiKey || null, !!m.izyfactureAutoFacturation]
    );
    return;
  }
  const liste = fs.existsSync(MERCHANTS_FILE) ? JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8")) : [];
  if (!Array.isArray(m.rolesMigres)) m.rolesMigres = CLES_MIGRATIONS_ROLES_CONNUES.slice();
  const idx = liste.findIndex((x) => x.id === m.id);
  if (idx === -1) liste.push(m); else liste[idx] = m;
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(liste, null, 2));
}

// Lit la fiche COMPLETE d'un marchand (utilisee en interne par addEmploye/updateEmploye/deleteEmploye pour
// lire son tableau `employes` avant de le muter puis le reecrire via insertMerchant). Retourne null si ce
// marchand n'existe pas.
async function getMerchantRecord(id) {
  if (pool) {
    await ensureMerchantsTable();
    const res = await pool.query(
      "SELECT id, nom, type, phone_number_id, admin_user, admin_password, phone_notification, actif, employes, logo_url, image_accueil_whatsapp_url, numero_whatsapp_public, option_stock_illimite, option_lien_commande, option_notifications_statut, roles_migres, izyfacture_api_key, izyfacture_auto_facturation FROM merchants WHERE id = $1",
      [id]
    );
    if (!res.rows.length) return null;
    return rowToMerchant(res.rows[0]);
  }
  const liste = fs.existsSync(MERCHANTS_FILE) ? JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8")) : [];
  return liste.find((x) => x.id === id) || null;
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
    // IMPORTANT : cette lecture doit inclure TOUTES les colonnes que rowToMerchant() lit, meme celles que
    // cette fonction ne modifie jamais elle-meme (employes, logo_url...) - sinon rowToMerchant() leur
    // applique sa valeur par defaut (employes: [], logoUrl: null) et l'ecriture plus bas (insertMerchant,
    // un UPSERT qui reecrit TOUTES les colonnes) efface silencieusement la vraie valeur en base. C'etait le
    // cas pour "employes" avant ce correctif : changer par ex. le numero de notification d'un marchand
    // ayant des employes les supprimait tous sans le vouloir.
    const res = await pool.query(
      "SELECT id, nom, type, phone_number_id, admin_user, admin_password, phone_notification, actif, employes, logo_url, image_accueil_whatsapp_url, numero_whatsapp_public, option_stock_illimite, option_lien_commande, option_notifications_statut, roles_migres, izyfacture_api_key, izyfacture_auto_facturation FROM merchants WHERE id = $1",
      [id]
    );
    if (!res.rows.length) return null;
    const m = rowToMerchant(res.rows[0]);
    if (patch.adminUser !== undefined) m.adminUser = patch.adminUser;
    if (patch.adminPassword !== undefined) m.adminPassword = patch.adminPassword;
    if (patch.phoneNotification !== undefined) m.phoneNotification = patch.phoneNotification;
    if (patch.actif !== undefined) m.actif = !!patch.actif;
    if (patch.logoUrl !== undefined) m.logoUrl = patch.logoUrl || null;
    if (patch.imageAccueilWhatsappUrl !== undefined) m.imageAccueilWhatsappUrl = patch.imageAccueilWhatsappUrl || null;
    if (patch.numeroWhatsappPublic !== undefined) m.numeroWhatsappPublic = patch.numeroWhatsappPublic || null;
    if (patch.optionStockIllimite !== undefined) m.optionStockIllimite = !!patch.optionStockIllimite;
    if (patch.optionLienCommande !== undefined) m.optionLienCommande = !!patch.optionLienCommande;
    if (patch.optionNotificationsStatut !== undefined) m.optionNotificationsStatut = !!patch.optionNotificationsStatut;
    // Pont IzyFacture : izyfactureApiKey doit arriver ICI deja chiffree (voir crypto-util.js) - cette
    // fonction ne chiffre rien elle-meme, elle stocke tel quel ce qu'on lui donne. Une chaine vide efface la
    // cle enregistree (autoFacturation repasse alors a false cote appelant, voir server.js).
    if (patch.izyfactureApiKey !== undefined) m.izyfactureApiKey = patch.izyfactureApiKey || null;
    if (patch.izyfactureAutoFacturation !== undefined) m.izyfactureAutoFacturation = !!patch.izyfactureAutoFacturation;
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
  if (patch.logoUrl !== undefined) liste[idx].logoUrl = patch.logoUrl || null;
  if (patch.imageAccueilWhatsappUrl !== undefined) liste[idx].imageAccueilWhatsappUrl = patch.imageAccueilWhatsappUrl || null;
  if (patch.numeroWhatsappPublic !== undefined) liste[idx].numeroWhatsappPublic = patch.numeroWhatsappPublic || null;
  if (patch.optionStockIllimite !== undefined) liste[idx].optionStockIllimite = !!patch.optionStockIllimite;
  if (patch.optionLienCommande !== undefined) liste[idx].optionLienCommande = !!patch.optionLienCommande;
  if (patch.optionNotificationsStatut !== undefined) liste[idx].optionNotificationsStatut = !!patch.optionNotificationsStatut;
  if (patch.izyfactureApiKey !== undefined) liste[idx].izyfactureApiKey = patch.izyfactureApiKey || null;
  if (patch.izyfactureAutoFacturation !== undefined) liste[idx].izyfactureAutoFacturation = !!patch.izyfactureAutoFacturation;
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

// ---------------- Employes d'un marchand (comptes a acces restreint) ----------------
// Stockes DANS la fiche du marchand (colonne "employes", tableau JSON) plutot que dans une table a part :
// un employe n'existe jamais independamment d'un marchand, et leur nombre par marchand reste toujours
// petit (quelques employes tout au plus) - inutile d'alourdir le schema d'une table dediee pour ca. Chaque
// employe : { id, nom, identifiant, motDePasseHash, roles: [...] } (voir ROLES_EMPLOYE_VALIDES et le
// controle d'acces dans server.js).

// Ajoute un employe a un marchand existant. Retourne l'employe ajoute, ou null si ce marchand n'existe pas.
async function addEmploye(merchantId, employe) {
  const m = await getMerchantRecord(merchantId);
  if (!m) return null;
  if (!Array.isArray(m.employes)) m.employes = [];
  m.employes.push(employe);
  await insertMerchant(m);
  return employe;
}

// Met a jour un ou plusieurs champs (nom, roles, motDePasseHash) d'UN employe existant, sans toucher aux
// autres. Retourne l'employe mis a jour, ou null si le marchand ou l'employe n'existe pas.
async function updateEmploye(merchantId, employeId, patch) {
  const m = await getMerchantRecord(merchantId);
  if (!m) return null;
  const emp = (m.employes || []).find((e) => e.id === employeId);
  if (!emp) return null;
  if (patch.nom !== undefined) emp.nom = patch.nom;
  if (patch.roles !== undefined) emp.roles = patch.roles;
  if (patch.motDePasseHash !== undefined) emp.motDePasseHash = patch.motDePasseHash;
  await insertMerchant(m);
  return emp;
}

// Supprime definitivement un employe. Retourne true si une entree a bien ete supprimee, false sinon
// (marchand ou employe introuvable).
async function deleteEmploye(merchantId, employeId) {
  const m = await getMerchantRecord(merchantId);
  if (!m) return false;
  const avant = (m.employes || []).length;
  m.employes = (m.employes || []).filter((e) => e.id !== employeId);
  if (m.employes.length === avant) return false;
  await insertMerchant(m);
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
  addEmploye,
  updateEmploye,
  deleteEmploye,
  initMerchantState,
  persistMerchantState,
  logConversationMessage,
  getConversationSummaries,
  getConversationHistory,
  usingDatabase: !!pool,
  CLES_MIGRATIONS_ROLES_CONNUES
};
