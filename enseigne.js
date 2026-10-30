// IzyVendeur - Volet ENSEIGNE (Etape 84) : reseau de magasins (supermarches) derriere UN SEUL numero WhatsApp.
// Fonctions PURES (aucun acces disque / reseau), partagees par le bot WhatsApp (conversation.js) et /admin (server.js).
//
// Option payante debloquee par le SEUL super-administrateur (merchant.optionEnseigne) : invisible du marchand tant que fermee.
//
// Donnees stockees dans l'etat du marchand (state.enseigne) :
//   magasins : [{ id, nom, quartier, adresse, telephone, actif, numerosAlerte:[], ruptures:[productId],
//                 creneaux:{ ouverture:"08:00", fermeture:"20:00", pasMinutes:30, delaiMinMinutes:60, joursAvance:2,
//                            capaciteParCreneau:10, joursFermes:[0..6] (0 = dimanche) } }
//   fidelite : { actif, montantParPoint (FCFA qui rapportent 1 point), seuilBon (points), valeurBon (FCFA), validiteBonJours }
//              -> TOUTES ces regles sont definies par le marchand (enseigne), jamais en dur.
//   clients  : { "<telephone>": { tel, favoris:[{productId,couleur,taille,quantite}], magasinPrefere,
//                 fidelite:{ consentement:null|true|false, date, points, totalPoints, nbBons } } }
//   bons     : [{ code, tel, valeur, creeLe, expireLe, utilise, utiliseLe, utilisePar, commande }]
//   prochainMagasin : compteur
//
// Fuseau : Africa/Douala (UTC+1, sans heure d'ete) : les creneaux sont calcules en heure locale fixe.

const crypto = require("crypto");

const DECALAGE_LOCAL_MS = 60 * 60 * 1000; // UTC+1
const MAX_MAGASINS = 200;
const MAX_FAVORIS = 20;
const ETATS_PREPA = ["nouvelle", "en_preparation", "prete", "retiree"];
const ALPHABET_BON = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I/L

const CRENEAUX_PAR_DEFAUT = { ouverture: "08:00", fermeture: "20:00", pasMinutes: 30, delaiMinMinutes: 60, joursAvance: 2, capaciteParCreneau: 10, joursFermes: [] };
const FIDELITE_PAR_DEFAUT = { actif: false, montantParPoint: 1000, seuilBon: 100, valeurBon: 5000, validiteBonJours: 90 };

function donneesParDefaut() {
  return { magasins: [], fidelite: Object.assign({}, FIDELITE_PAR_DEFAUT), clients: {}, bons: [], prochainMagasin: 1 };
}

function entierBorne(v, min, max, defaut) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function texte(v, max) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || 200); }

function heureValide(h) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || "")); }
function minutesDe(h) { const [a, b] = String(h).split(":").map(Number); return a * 60 + b; }
function hhmm(min) { return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"); }

function normaliserCreneaux(c) {
  const s = c && typeof c === "object" ? c : {};
  const out = Object.assign({}, CRENEAUX_PAR_DEFAUT);
  if (heureValide(s.ouverture)) out.ouverture = s.ouverture;
  if (heureValide(s.fermeture)) out.fermeture = s.fermeture;
  if (minutesDe(out.fermeture) <= minutesDe(out.ouverture)) { out.ouverture = CRENEAUX_PAR_DEFAUT.ouverture; out.fermeture = CRENEAUX_PAR_DEFAUT.fermeture; }
  out.pasMinutes = [15, 20, 30, 45, 60, 90, 120].indexOf(Number(s.pasMinutes)) !== -1 ? Number(s.pasMinutes) : CRENEAUX_PAR_DEFAUT.pasMinutes;
  out.delaiMinMinutes = entierBorne(s.delaiMinMinutes, 0, 24 * 60, CRENEAUX_PAR_DEFAUT.delaiMinMinutes);
  out.joursAvance = entierBorne(s.joursAvance, 0, 14, CRENEAUX_PAR_DEFAUT.joursAvance);
  out.capaciteParCreneau = entierBorne(s.capaciteParCreneau, 1, 500, CRENEAUX_PAR_DEFAUT.capaciteParCreneau);
  const fermes = Array.isArray(s.joursFermes) ? s.joursFermes.map(Number).filter((j) => Number.isInteger(j) && j >= 0 && j <= 6) : [];
  out.joursFermes = fermes.filter((j, i) => fermes.indexOf(j) === i).sort();
  return out;
}

function normaliserNumeros(liste) {
  const vus = new Set(); const out = [];
  (Array.isArray(liste) ? liste : String(liste || "").split(/[\n,;]+/)).forEach((n) => {
    const t = texte(n, 30); const c = t.replace(/\D/g, "");
    if (c.length >= 8 && !vus.has(c)) { vus.add(c); out.push(t); }
  });
  return out.slice(0, 10);
}

function normaliserMagasin(m, id) {
  return {
    id,
    nom: texte(m.nom, 80),
    quartier: texte(m.quartier, 60),
    adresse: texte(m.adresse, 160),
    telephone: texte(m.telephone, 30),
    actif: m.actif !== false,
    numerosAlerte: normaliserNumeros(m.numerosAlerte),
    ruptures: Array.isArray(m.ruptures) ? m.ruptures.map(String).filter((x, i, a) => x && a.indexOf(x) === i) : [],
    creneaux: normaliserCreneaux(m.creneaux)
  };
}

function normaliserFidelite(f) {
  const s = f && typeof f === "object" ? f : {};
  return {
    actif: s.actif === true,
    montantParPoint: entierBorne(s.montantParPoint, 1, 1000000, FIDELITE_PAR_DEFAUT.montantParPoint),
    seuilBon: entierBorne(s.seuilBon, 1, 1000000, FIDELITE_PAR_DEFAUT.seuilBon),
    valeurBon: entierBorne(s.valeurBon, 1, 100000000, FIDELITE_PAR_DEFAUT.valeurBon),
    validiteBonJours: entierBorne(s.validiteBonJours, 1, 1095, FIDELITE_PAR_DEFAUT.validiteBonJours)
  };
}

// Complete / normalise un objet `enseigne` charge depuis l'etat (retro-compatibilite : absent = valeurs par defaut).
function assurer(e) {
  const x = e && typeof e === "object" ? e : {};
  if (!Array.isArray(x.magasins)) x.magasins = [];
  x.magasins = x.magasins.map((m) => normaliserMagasin(m, m.id));
  x.fidelite = normaliserFidelite(x.fidelite);
  if (!x.clients || typeof x.clients !== "object") x.clients = {};
  if (!Array.isArray(x.bons)) x.bons = [];
  if (!Number.isInteger(x.prochainMagasin) || x.prochainMagasin < 1) x.prochainMagasin = 1 + x.magasins.reduce((mx, m) => Math.max(mx, Number(String(m.id).replace(/\D/g, "")) || 0), 0);
  return x;
}

// ---------------- Telephone / dates ----------------
function cleTel(t) { if (String(t) === "SIMULATEUR") return "SIMULATEUR"; const c = String(t == null ? "" : t).replace(/\D/g, ""); return c.length > 9 ? c.slice(-9) : c; }
function localise(date) { return new Date(date.getTime() + DECALAGE_LOCAL_MS); }
function jourISO(dLocal) { return dLocal.getUTCFullYear() + "-" + String(dLocal.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dLocal.getUTCDate()).padStart(2, "0"); }
function dateDepuisLocal(jour, heure) { // "2026-11-02", "09:30" (heure locale) -> Date reelle
  const [a, m, j] = jour.split("-").map(Number); const [h, mi] = heure.split(":").map(Number);
  return new Date(Date.UTC(a, m - 1, j, h, mi) - DECALAGE_LOCAL_MS);
}
const JOURS_FR = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const JOURS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function libelleJour(jour, maintenant, langue) {
  const en = langue === "en";
  const auj = jourISO(localise(maintenant));
  const dem = jourISO(localise(new Date(maintenant.getTime() + 24 * 3600 * 1000)));
  const [a, m, j] = jour.split("-").map(Number);
  const nomJour = (en ? JOURS_EN : JOURS_FR)[new Date(Date.UTC(a, m - 1, j)).getUTCDay()];
  const num = String(j).padStart(2, "0") + "/" + String(m).padStart(2, "0");
  if (jour === auj) return (en ? "Today" : "Aujourd'hui") + " " + num;
  if (jour === dem) return (en ? "Tomorrow" : "Demain") + " " + num;
  return nomJour + " " + num;
}

// ---------------- Magasins ----------------
function magasinsActifs(e) { return e.magasins.filter((m) => m.actif !== false); }
function trouverMagasin(e, id) { return e.magasins.filter((m) => m.id === id)[0] || null; }

function ajouterMagasin(e, entree) {
  if (e.magasins.length >= MAX_MAGASINS) return { erreur: "Nombre maximal de magasins atteint (" + MAX_MAGASINS + ")." };
  const nom = texte(entree && entree.nom, 80);
  if (!nom) return { erreur: "Le nom du magasin est obligatoire." };
  if (e.magasins.some((m) => m.nom.toLowerCase() === nom.toLowerCase() && m.quartier.toLowerCase() === texte(entree.quartier, 60).toLowerCase())) return { erreur: "Un magasin du même nom existe déjà dans ce quartier." };
  const m = normaliserMagasin(Object.assign({}, entree, { ruptures: [] }), "M" + e.prochainMagasin++);
  e.magasins.push(m);
  return { magasin: m };
}

function modifierMagasin(e, id, patch) {
  const m = trouverMagasin(e, id);
  if (!m) return { erreur: "Magasin introuvable." };
  const p = patch || {};
  const fusion = Object.assign({}, m, p, { creneaux: p.creneaux ? Object.assign({}, m.creneaux, p.creneaux) : m.creneaux });
  if (p.nom !== undefined && !texte(p.nom, 80)) return { erreur: "Le nom du magasin est obligatoire." };
  const n = normaliserMagasin(fusion, m.id);
  if (p.ruptures === undefined) n.ruptures = m.ruptures; // les ruptures ne changent que par definirRuptures
  Object.assign(m, n);
  return { magasin: m };
}

function retirerMagasin(e, id) {
  const i = e.magasins.findIndex((m) => m.id === id);
  if (i === -1) return { erreur: "Magasin introuvable." };
  e.magasins.splice(i, 1);
  return { ok: true };
}

// Le magasin ne vend plus un produit tant que `indisponible` est vrai (catalogue commun, ruptures par magasin).
function definirRupture(e, magasinId, produitId, indisponible) {
  const m = trouverMagasin(e, magasinId);
  if (!m) return { erreur: "Magasin introuvable." };
  const id = String(produitId);
  const i = m.ruptures.indexOf(id);
  if (indisponible && i === -1) m.ruptures.push(id);
  if (!indisponible && i !== -1) m.ruptures.splice(i, 1);
  return { magasin: m };
}
function definirRuptures(e, magasinId, ids) {
  const m = trouverMagasin(e, magasinId);
  if (!m) return { erreur: "Magasin introuvable." };
  m.ruptures = (Array.isArray(ids) ? ids : []).map(String).filter((x, i, a) => x && a.indexOf(x) === i);
  return { magasin: m };
}
function enRupture(magasin, produitId) { return !!magasin && magasin.ruptures.indexOf(String(produitId)) !== -1; }

// ---------------- Creneaux de retrait ----------------
// Capacite : nombre de commandes non annulees deja prises sur un meme creneau d'un meme magasin.
function creneauxDisponibles(magasin, commandes, maintenant) {
  const now = maintenant || new Date();
  const c = magasin.creneaux;
  const ouv = minutesDe(c.ouverture); const fer = minutesDe(c.fermeture);
  const occupe = {};
  (commandes || []).forEach((o) => {
    if (o.magasinId === magasin.id && o.creneau && o.creneau.id && o.statut !== "Annulée") occupe[o.creneau.id] = (occupe[o.creneau.id] || 0) + 1;
  });
  const limite = new Date(now.getTime() + c.delaiMinMinutes * 60000);
  const jours = [];
  for (let d = 0; d <= c.joursAvance; d++) {
    const dl = localise(new Date(now.getTime() + d * 24 * 3600 * 1000));
    if (c.joursFermes.indexOf(dl.getUTCDay()) !== -1) continue;
    const jour = jourISO(dl);
    const liste = [];
    for (let t = ouv; t + c.pasMinutes <= fer; t += c.pasMinutes) {
      const heure = hhmm(t);
      const id = jour + "T" + heure;
      if (dateDepuisLocal(jour, heure) < limite) continue;
      if ((occupe[id] || 0) >= c.capaciteParCreneau) continue;
      liste.push({ id, jour, heure, fin: hhmm(t + c.pasMinutes) });
    }
    if (liste.length) jours.push({ jour, creneaux: liste });
  }
  return jours;
}

// Verifie qu'un creneau est toujours libre et renvoie l'objet a enregistrer sur la commande.
function resoudreCreneau(magasin, id, commandes, maintenant, langue) {
  const now = maintenant || new Date();
  const jours = creneauxDisponibles(magasin, commandes, now);
  for (const j of jours) {
    const c = j.creneaux.filter((x) => x.id === id)[0];
    if (c) return { creneau: { id: c.id, jour: c.jour, debut: c.heure, fin: c.fin, debutISO: dateDepuisLocal(c.jour, c.heure).toISOString(), libelle: libelleCreneau(c, now, langue) } };
  }
  return { erreur: "Ce créneau n'est plus disponible." };
}
function libelleCreneau(c, maintenant, langue) {
  return libelleJour(c.jour, maintenant || new Date(), langue) + " " + (c.heure || c.debut) + "–" + c.fin;
}
function libelleCreneauCommande(cr, langue) {
  if (!cr) return "";
  return langue === "en" && cr.libelleEn ? cr.libelleEn : cr.libelle;
}

// ---------------- Preparation ----------------
// Etat de preparation d'une commande de retrait : nouvelle -> en_preparation -> prete -> retiree (retour arriere refuse sauf
// prete -> en_preparation). `retiree` est final : c'est elle qui credite les points et passe la commande en « Livrée ».
function transitionPrepaPossible(de, vers) {
  if (ETATS_PREPA.indexOf(vers) === -1) return false;
  if (de === vers) return false;
  if (de === "retiree") return false;
  const i = ETATS_PREPA.indexOf(de); const j = ETATS_PREPA.indexOf(vers);
  if (j > i) return true; // avancer (on peut sauter une etape : ex. nouvelle -> prete)
  return de === "prete" && vers === "en_preparation";
}
function changerPrepa(order, vers, par, maintenant) {
  const de = order.prepa || "nouvelle";
  if (!transitionPrepaPossible(de, vers)) return { erreur: "Changement d'état impossible : " + de + " → " + vers + "." };
  order.prepa = vers;
  if (!Array.isArray(order.prepaHistorique)) order.prepaHistorique = [{ etat: "nouvelle", dateISO: order.dateISO }];
  order.prepaHistorique.push({ etat: vers, dateISO: (maintenant || new Date()).toISOString(), par: par || null });
  return { de, vers };
}

// ---------------- Clients / favoris / fidelite ----------------
function compteClient(e, tel, creer) {
  const k = cleTel(tel);
  if (!k) return null;
  let c = e.clients[k];
  if (!c && creer) {
    c = e.clients[k] = { tel: k, favoris: [], magasinPrefere: null, fidelite: { consentement: null, date: null, points: 0, totalPoints: 0, nbBons: 0 } };
  }
  if (c) {
    if (!Array.isArray(c.favoris)) c.favoris = [];
    if (!c.fidelite) c.fidelite = { consentement: null, date: null, points: 0, totalPoints: 0, nbBons: 0 };
  }
  return c || null;
}

function ajouterFavoris(e, tel, lignes) {
  const c = compteClient(e, tel, true);
  if (!c) return { erreur: "Numéro invalide." };
  let ajoutes = 0;
  (lignes || []).forEach((l) => {
    const cle = (x) => [x.productId, x.couleur || "", x.taille || ""].join("|");
    const existant = c.favoris.filter((f) => cle(f) === cle(l))[0];
    const quantite = entierBorne(l.quantite, 1, 99, 1);
    if (existant) { existant.quantite = quantite; return; }
    if (c.favoris.length >= MAX_FAVORIS) return;
    c.favoris.push({ productId: String(l.productId), couleur: l.couleur || "", taille: l.taille || "", quantite });
    ajoutes++;
  });
  return { ajoutes, total: c.favoris.length, pleins: c.favoris.length >= MAX_FAVORIS };
}
function retirerFavori(e, tel, index) {
  const c = compteClient(e, tel, false);
  if (!c || !Number.isInteger(index) || index < 0 || index >= c.favoris.length) return { erreur: "Favori introuvable." };
  return { retire: c.favoris.splice(index, 1)[0] };
}

function pointsPour(montant, fid) {
  return fid && fid.montantParPoint > 0 ? Math.floor(Math.max(0, Number(montant) || 0) / fid.montantParPoint) : 0;
}

function enregistrerConsentement(e, tel, accepte, maintenant) {
  const c = compteClient(e, tel, true);
  if (!c) return { erreur: "Numéro invalide." };
  c.fidelite.consentement = accepte === true;
  c.fidelite.date = (maintenant || new Date()).toISOString();
  return { compte: c };
}

function codeBon(e) {
  for (let essai = 0; essai < 50; essai++) {
    let code = "BON-";
    const octets = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += ALPHABET_BON[octets[i] % ALPHABET_BON.length];
    if (!e.bons.some((b) => b.code === code)) return code;
  }
  return "BON-" + Date.now().toString(36).toUpperCase();
}

// Credite les points d'une commande RETIREE (une seule fois : order.pointsCredites). Les points ne sont acquis que si le client a accepte
// le programme (consentement). A chaque franchissement du seuil, un bon a usage unique est emis et le seuil est deduit des points.
function crediterCommande(e, order, maintenant) {
  const fid = e.fidelite;
  if (!fid.actif) return { credit: 0, bons: [], raison: "programme inactif" };
  if (order.pointsCredites !== undefined && order.pointsCredites !== null) return { credit: 0, bons: [], raison: "déjà crédité" };
  const c = compteClient(e, order.fromWhatsapp || order.telephone, false);
  if (!c || c.fidelite.consentement !== true) return { credit: 0, bons: [], raison: "pas de compte fidélité" };
  const now = maintenant || new Date();
  const pts = pointsPour(order.prix, fid);
  order.pointsCredites = pts;
  c.fidelite.points += pts;
  c.fidelite.totalPoints += pts;
  const bons = [];
  while (fid.seuilBon > 0 && c.fidelite.points >= fid.seuilBon) {
    c.fidelite.points -= fid.seuilBon;
    c.fidelite.nbBons += 1;
    const b = { code: codeBon(e), tel: c.tel, valeur: fid.valeurBon, creeLe: now.toISOString(), expireLe: new Date(now.getTime() + fid.validiteBonJours * 24 * 3600 * 1000).toISOString(), utilise: false, utiliseLe: null, utilisePar: null, commande: null };
    e.bons.push(b); bons.push(b);
  }
  return { credit: pts, bons, solde: c.fidelite.points };
}

function bonsDuClient(e, tel, maintenant) {
  const k = cleTel(tel); const now = (maintenant || new Date()).getTime();
  return e.bons.filter((b) => b.tel === k && !b.utilise && new Date(b.expireLe).getTime() >= now);
}

function soldeClient(e, tel, maintenant) {
  const c = compteClient(e, tel, false);
  const fid = e.fidelite;
  if (!c || c.fidelite.consentement !== true) return null;
  const pts = c.fidelite.points;
  return { points: pts, seuilBon: fid.seuilBon, manque: Math.max(0, fid.seuilBon - pts), valeurBon: fid.valeurBon, bons: bonsDuClient(e, tel, maintenant) };
}

// Validation d'un bon au retrait par l'equipe du magasin : verifie, puis marque UTILISE (usage unique).
function utiliserBon(e, code, ctx, maintenant) {
  const c = String(code || "").trim().toUpperCase();
  const b = e.bons.filter((x) => x.code === c)[0];
  const now = maintenant || new Date();
  if (!b) return { erreur: "Code inconnu." };
  if (b.utilise) return { erreur: "Ce bon a déjà été utilisé (" + new Date(b.utiliseLe).toLocaleDateString("fr-FR") + ")." };
  if (new Date(b.expireLe).getTime() < now.getTime()) return { erreur: "Ce bon a expiré le " + new Date(b.expireLe).toLocaleDateString("fr-FR") + "." };
  b.utilise = true; b.utiliseLe = now.toISOString(); b.utilisePar = (ctx && ctx.par) || null; b.commande = (ctx && ctx.commande) || null; b.magasinId = (ctx && ctx.magasinId) || null;
  return { bon: b };
}
function verifierBon(e, code, maintenant) {
  const c = String(code || "").trim().toUpperCase();
  const b = e.bons.filter((x) => x.code === c)[0];
  const now = maintenant || new Date();
  if (!b) return { erreur: "Code inconnu." };
  if (b.utilise) return { erreur: "Ce bon a déjà été utilisé." };
  if (new Date(b.expireLe).getTime() < now.getTime()) return { erreur: "Ce bon a expiré." };
  return { bon: b };
}

// ---------------- Statistiques de la vue Direction ----------------
function debutFinPeriode(periode, ref) {
  const now = ref || new Date();
  const dl = localise(now);
  const y = dl.getUTCFullYear(); const m = dl.getUTCMonth(); const d = dl.getUTCDate();
  const utc = (a, b, c) => new Date(Date.UTC(a, b, c) - DECALAGE_LOCAL_MS);
  if (periode === "jour") return { debut: utc(y, m, d), fin: utc(y, m, d + 1) };
  if (periode === "semaine") { const dow = (dl.getUTCDay() + 6) % 7; return { debut: utc(y, m, d - dow), fin: utc(y, m, d - dow + 7) }; }
  if (periode === "mois") return { debut: utc(y, m, 1), fin: utc(y, m + 1, 1) };
  if (periode === "annee") return { debut: utc(y, 0, 1), fin: utc(y + 1, 0, 1) };
  return { debut: new Date(0), fin: new Date(8640000000000000) };
}
// Periode calendaire qui precede (jour, semaine, mois, annee) ; pour « tout », la periode precedente est vide.
function periodePrecedente(periode, debut) {
  if (periode === "tout") return { debut: new Date(0), fin: new Date(0) };
  return debutFinPeriode(periode, new Date(debut.getTime() - 1));
}

// Chiffre d'affaires = commandes « Livrée » (donc retirees et payees en caisse). Les commandes WhatsApp confirmees mais pas encore
// retirees sont comptees a part (« en cours »).
function statistiquesPeriode(e, commandes, debut, fin) {
  const dans = (o) => { const t = new Date(o.dateISO).getTime(); return t >= debut.getTime() && t < fin.getTime(); };
  const liste = (commandes || []).filter((o) => o.magasinId && o.source !== "simulateur" && dans(o));
  const parMagasin = {};
  e.magasins.forEach((m) => { parMagasin[m.id] = nouvelleStat(m); });
  liste.forEach((o) => {
    const s = parMagasin[o.magasinId] || (parMagasin[o.magasinId] = nouvelleStat({ id: o.magasinId, nom: o.magasinNom || o.magasinId, quartier: "" }));
    s.commandes++;
    if (o.statut === "Annulée") { s.annulees++; return; }
    if (o.statut === "Nouvelle") { s.nonConfirmees++; return; }
    if (o.statut === "Livrée") {
      s.retirees++; s.ca += o.prix;
      (o.items || []).forEach((it) => { const k = it.produit; const p = s.produits[k] || (s.produits[k] = { produit: k, quantite: 0, montant: 0 }); p.quantite += it.quantite; p.montant += it.prix || it.prixUnitaire * it.quantite; });
      const h = (o.prepaHistorique || []);
      const debutPrepa = h.filter((x) => x.etat === "en_preparation")[0] || h[0];
      const prete = h.filter((x) => x.etat === "prete")[0];
      if (debutPrepa && prete) { const dm = (new Date(prete.dateISO) - new Date(o.dateISO)) / 60000; if (dm >= 0) { s.delaiTotal += dm; s.delaiN++; } }
    } else s.enCours++;
  });
  const lignes = Object.keys(parMagasin).map((id) => finaliserStat(parMagasin[id]));
  const total = lignes.reduce((t, s) => {
    t.commandes += s.commandes; t.retirees += s.retirees; t.annulees += s.annulees; t.enCours += s.enCours; t.ca += s.ca; return t;
  }, { commandes: 0, retirees: 0, annulees: 0, enCours: 0, ca: 0 });
  total.panierMoyen = total.retirees ? Math.round(total.ca / total.retirees) : 0;
  total.tauxAnnulation = total.commandes ? Math.round(1000 * total.annulees / total.commandes) / 10 : 0;
  const agg = {};
  lignes.forEach((s) => s.topProduits.forEach((p) => { const a = agg[p.produit] || (agg[p.produit] = { produit: p.produit, quantite: 0, montant: 0 }); a.quantite += p.quantite; a.montant += p.montant; }));
  total.topProduits = Object.keys(agg).map((k) => agg[k]).sort((a, b) => b.quantite - a.quantite).slice(0, 10);
  return { magasins: lignes, total };
}
function nouvelleStat(m) { return { id: m.id, nom: m.nom, quartier: m.quartier || "", commandes: 0, retirees: 0, annulees: 0, nonConfirmees: 0, enCours: 0, ca: 0, produits: {}, delaiTotal: 0, delaiN: 0 }; }
function finaliserStat(s) {
  return {
    id: s.id, nom: s.nom, quartier: s.quartier, commandes: s.commandes, retirees: s.retirees, annulees: s.annulees, nonConfirmees: s.nonConfirmees, enCours: s.enCours, ca: s.ca,
    panierMoyen: s.retirees ? Math.round(s.ca / s.retirees) : 0,
    tauxAnnulation: s.commandes ? Math.round(1000 * s.annulees / s.commandes) / 10 : 0,
    delaiPreparationMin: s.delaiN ? Math.round(s.delaiTotal / s.delaiN) : null,
    topProduits: Object.keys(s.produits).map((k) => s.produits[k]).sort((a, b) => b.quantite - a.quantite).slice(0, 5)
  };
}
function statistiquesFidelite(e, debut, fin) {
  const inscrits = Object.keys(e.clients).filter((k) => k !== "SIMULATEUR" && e.clients[k].fidelite && e.clients[k].fidelite.consentement === true);
  const refus = Object.keys(e.clients).filter((k) => k !== "SIMULATEUR" && e.clients[k].fidelite && e.clients[k].fidelite.consentement === false).length;
  const dans = (iso) => { const t = new Date(iso).getTime(); return t >= debut.getTime() && t < fin.getTime(); };
  const inscritsPeriode = inscrits.filter((k) => e.clients[k].fidelite.date && dans(e.clients[k].fidelite.date)).length;
  const bonsReels = e.bons.filter((b) => b.tel !== "SIMULATEUR");
  const emis = bonsReels.filter((b) => dans(b.creeLe));
  const utilises = bonsReels.filter((b) => b.utilise && b.utiliseLe && dans(b.utiliseLe));
  return {
    actif: e.fidelite.actif,
    clientsInscrits: inscrits.length, refus, inscritsPeriode,
    pointsEnCirculation: inscrits.reduce((t, k) => t + e.clients[k].fidelite.points, 0),
    pointsDistribues: inscrits.reduce((t, k) => t + e.clients[k].fidelite.totalPoints, 0),
    bonsEmis: emis.length, bonsUtilises: utilises.length, valeurBonsUtilises: utilises.reduce((t, b) => t + b.valeur, 0),
    bonsEnAttente: bonsReels.filter((b) => !b.utilise && new Date(b.expireLe).getTime() >= Date.now()).length
  };
}

module.exports = {
  ETATS_PREPA, MAX_FAVORIS, FIDELITE_PAR_DEFAUT, CRENEAUX_PAR_DEFAUT,
  donneesParDefaut, assurer, normaliserFidelite, normaliserNumeros, cleTel,
  magasinsActifs, trouverMagasin, ajouterMagasin, modifierMagasin, retirerMagasin,
  definirRupture, definirRuptures, enRupture,
  creneauxDisponibles, resoudreCreneau, libelleJour, libelleCreneauCommande, dateDepuisLocal, jourISO, localise,
  transitionPrepaPossible, changerPrepa,
  compteClient, ajouterFavoris, retirerFavori, pointsPour, enregistrerConsentement, crediterCommande, bonsDuClient, soldeClient, utiliserBon, verifierBon,
  debutFinPeriode, periodePrecedente, statistiquesPeriode, statistiquesFidelite
};
