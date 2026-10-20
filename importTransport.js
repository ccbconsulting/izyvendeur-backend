"use strict";
// Etape 75 : import CSV du volet transport (lignes + tarifs, puis departs + quotas). Fonctions pures, sans acces au disque ni au reseau :
// server.js lit le fichier, appelle analyserLignes / analyserDeparts, puis enregistre via le moteur (updateLignes / updateDeparts).
// Une ligne de fichier = une ligne de transport (fichier 1) ou un depart (fichier 2). Fusionne toujours avec l'existant : un nom
// de ligne deja present, ou un depart (ligne + sens + heure) deja present, est ignore (un fichier renvoye deux fois ne cree aucun doublon).

const MAX_LIGNES_FICHIER = 200;

function norm(s) {
  return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

// Lit le CSV : { erreur } ou { rows: [{ n (numero de ligne du fichier), c: [champs] }], col(...motsCles) -> index ou -1 }.
function lireCsv(texte, outils) {
  const brut = String(texte == null ? "" : texte).replace(/^﻿/, "");
  const lignes = brut.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (!lignes.length) return { erreur: "Fichier vide." };
  if (lignes.length > MAX_LIGNES_FICHIER + 1) return { erreur: "Fichier trop long (" + MAX_LIGNES_FICHIER + " lignes maximum par import)." };
  const sep = lignes[0].indexOf(";") !== -1 ? ";" : ",";
  const entetes = outils.parserLigneCsv(lignes[0], sep).map(norm);
  const col = (...mots) => entetes.findIndex((h) => mots.some((m) => h.indexOf(m) !== -1));
  const rows = [];
  for (let i = 1; i < lignes.length; i++) rows.push({ n: i + 1, c: outils.parserLigneCsv(lignes[i], sep) });
  return { rows, col };
}

function entier(v) { const n = parseInt(String(v == null ? "" : v).replace(/[^\d]/g, ""), 10); return Number.isFinite(n) ? n : null; }
function heureDe(v) {
  const m = String(v == null ? "" : v).trim().match(/^(\d{1,2})\s*[h:Hh]\s*(\d{2})?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = m[2] ? parseInt(m[2], 10) : 0;
  if (h > 23 || mi > 59) return null;
  return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
}
const MODES = { train: "train", navette: "navette", car: "car", bus: "car", autocar: "car", autre: "autre", other: "autre", shuttle: "navette", coach: "car" };

// ---------------- Fichier 1 : lignes, arrets, classes, tarifs ----------------
// Colonnes (ordre libre, casse et accents ignores) : "Ligne", "Type" (facultatif), "Arrets", "Classes", "Tarifs".
//   Arrets  : Douala (0) > Edea (66) > Eseka (150) > Yaounde (263)       (distance en km depuis le depart, entre parentheses)
//   Classes : Premium (fenetre/couloir) | Premiere classe (fenetre/couloir)   (sans parentheses : pas de choix de cote)
//   Tarifs  : Premium = 6000 / 11000 | Premiere classe = 9000 / 15000      (prix de bout en bout simple / aller-retour)
// Les prix des arrets intermediaires sont calcules selon la distance (comme le generateur de tarifs de /admin).
function analyserLignes(texte, existantes, outils, calculerTarifs) {
  const f = lireCsv(texte, outils);
  if (f.erreur) return { erreur: f.erreur };
  const iNom = f.col("ligne", "nom"), iType = f.col("type", "mode"), iArrets = f.col("arret"), iClasses = f.col("classe"), iTarifs = f.col("tarif", "prix");
  if (iNom === -1 || iArrets === -1 || iClasses === -1 || iTarifs === -1) {
    return { erreur: "Colonnes attendues introuvables (\"Ligne\", \"Arrêts\", \"Classes\" et \"Tarifs\" ; \"Type\" facultatif)." };
  }
  const vus = new Set((existantes || []).map((l) => norm(l.nom)));
  const nouvelles = [], doublons = [], erreurs = [];
  const base = Date.now().toString(36);
  f.rows.forEach((row) => {
    const nom = String(row.c[iNom] || "").trim();
    if (!nom) return;
    const err = (m) => erreurs.push("ligne " + row.n + " (" + nom.slice(0, 30) + ") : " + m);
    if (nom.length > 80) return err("nom trop long (80 caractères maximum)");
    if (vus.has(norm(nom))) { if (doublons.indexOf(nom) === -1) doublons.push(nom); return; }
    // arrets
    const morceaux = String(row.c[iArrets] || "").split(/>|→|›/).map((x) => x.trim()).filter(Boolean);
    if (morceaux.length < 2) return err("au moins deux arrêts séparés par « > »");
    if (morceaux.length > 15) return err("15 arrêts au maximum");
    const arrets = []; let sansDistance = 0;
    for (let j = 0; j < morceaux.length; j++) {
      const m = morceaux[j].match(/^(.*?)\s*\(\s*([\d.,\s]*)\s*(?:km)?\s*\)\s*$/i);
      const an = (m ? m[1] : morceaux[j]).trim();
      if (!an || an.length > 60) return err("nom d'arrêt invalide");
      let pk = null;
      if (m && m[2].trim() !== "") { pk = parseFloat(m[2].replace(/\s/g, "").replace(",", ".")); if (!Number.isFinite(pk) || pk < 0) return err("distance invalide pour « " + an + " »"); }
      if (pk == null) sansDistance++;
      arrets.push({ id: "a" + j, nom: an, pk });
    }
    if (sansDistance === arrets.length) arrets.forEach((a, j) => { a.pk = j * 100; }); // aucune distance : arrets equidistants
    else if (sansDistance) return err("distance manquante pour certains arrêts (renseignez-les toutes, ou aucune)");
    for (let j = 1; j < arrets.length; j++) if (arrets[j].pk < arrets[j - 1].pk) return err("les distances doivent croître le long du trajet");
    if (arrets[arrets.length - 1].pk <= arrets[0].pk) return err("la distance d'arrivée doit dépasser celle du départ");
    // classes
    const classes = [];
    const morceauxClasses = String(row.c[iClasses] || "").split("|").map((x) => x.trim()).filter(Boolean);
    if (!morceauxClasses.length) return err("au moins une classe");
    if (morceauxClasses.length > 8) return err("8 classes au maximum");
    for (let j = 0; j < morceauxClasses.length; j++) {
      const m = morceauxClasses[j].match(/^(.*?)\s*\((.*)\)\s*$/);
      const cn = (m ? m[1] : morceauxClasses[j]).trim();
      if (!cn || cn.length > 40) return err("nom de classe invalide");
      if (classes.some((c) => norm(c.nom) === norm(cn))) return err("classe « " + cn + " » en double");
      classes.push({ id: "c" + j, nom: cn, cote: m ? /fen|cou|oui|yes|side|window|aisle|cote/.test(norm(m[2])) : false, description: "" });
    }
    // tarifs
    const prixDe = {};
    const morceauxTarifs = String(row.c[iTarifs] || "").split("|").map((x) => x.trim()).filter(Boolean);
    for (let j = 0; j < morceauxTarifs.length; j++) {
      const k = morceauxTarifs[j].lastIndexOf("=");
      if (k === -1) return err("tarif mal écrit (« Classe = prix / prix aller-retour ») : " + morceauxTarifs[j].slice(0, 30));
      const cn = morceauxTarifs[j].slice(0, k).trim();
      const classe = classes.filter((c) => norm(c.nom) === norm(cn))[0];
      if (!classe) return err("tarif pour une classe inconnue : « " + cn + " »");
      const parts = morceauxTarifs[j].slice(k + 1).split("/");
      const prix = entier(parts[0]), prixAR = parts[1] != null && String(parts[1]).trim() !== "" ? entier(parts[1]) : 0;
      if (!prix || prix < 1 || prixAR == null) return err("prix invalide pour la classe « " + classe.nom + " »");
      prixDe[classe.id] = { prix, prixAR };
    }
    const sansTarif = classes.filter((c) => !prixDe[c.id])[0];
    if (sansTarif) return err("pas de tarif pour la classe « " + sansTarif.nom + " »");
    vus.add(norm(nom));
    const ligne = { id: "l" + base + "_" + nouvelles.length, nom, mode: MODES[norm(iType === -1 ? "" : row.c[iType])] || "autre", actif: true, arrets, classes, tarifs: [] };
    ligne.tarifs = calculerTarifs(ligne, prixDe);
    nouvelles.push(ligne);
  });
  return { nouvelles, doublons, erreurs };
}

// ---------------- Fichier 2 : departs et quotas ----------------
// Colonnes : "Ligne", "Sens" (aller / retour), "Heure" (06:30 ou 6h30), "Jours" (tous, ou lun,mar,mer,jeu,ven,sam,dim),
// "Passages" (facultatif : Douala=06:30 | Edea=07:30 ...), "Quotas" (places vendues sur WhatsApp :
//   Premium = 20/20 | Premiere classe = 10/10     -> fenetre/couloir ; un seul nombre pour une classe a cote se partage en deux ;
//   Standard = 14                                  -> classe sans choix de cote).
const JOURS_CODES = { dim: 0, dimanche: 0, sun: 0, lun: 1, lundi: 1, mon: 1, mar: 2, mardi: 2, tue: 2, mer: 3, mercredi: 3, wed: 3, jeu: 4, jeudi: 4, thu: 4, ven: 5, vendredi: 5, fri: 5, sam: 6, samedi: 6, sat: 6 };
function analyserDeparts(texte, lignes, existants, outils) {
  const f = lireCsv(texte, outils);
  if (f.erreur) return { erreur: f.erreur };
  const iLigne = f.col("ligne"), iSens = f.col("sens"), iHeure = f.col("heure"), iJours = f.col("jour"), iPass = f.col("passage"), iQuotas = f.col("quota", "places");
  if (iLigne === -1 || iSens === -1 || iHeure === -1 || iQuotas === -1) {
    return { erreur: "Colonnes attendues introuvables (\"Ligne\", \"Sens\", \"Heure\" et \"Quotas\" ; \"Jours\" et \"Passages\" facultatives)." };
  }
  const parNom = {}; (lignes || []).forEach((l) => { parNom[norm(l.nom)] = l; });
  const cle = (ligneId, sens, heure) => ligneId + "|" + sens + "|" + heure;
  const vus = new Set((existants || []).map((d) => cle(d.ligneId, d.sens, d.heure)));
  const nouveaux = [], doublons = [], erreurs = [];
  const base = Date.now().toString(36);
  f.rows.forEach((row) => {
    const nomLigne = String(row.c[iLigne] || "").trim();
    if (!nomLigne) return;
    const err = (m) => erreurs.push("ligne " + row.n + " (" + nomLigne.slice(0, 30) + ") : " + m);
    const ligne = parNom[norm(nomLigne)];
    if (!ligne) return err("ligne inconnue (importez d'abord le fichier des lignes)");
    const s = norm(row.c[iSens]);
    const sens = /^(aller|1|\+1|outbound|aller simple)$/.test(s) ? 1 : /^(retour|-1|return|inbound)$/.test(s) ? -1 : 0;
    if (!sens) return err("sens invalide (« aller » ou « retour »)");
    const heure = heureDe(row.c[iHeure]);
    if (!heure) return err("heure invalide (ex. 06:30 ou 6h30)");
    // jours
    let jours = [0, 1, 2, 3, 4, 5, 6];
    const jtxt = iJours === -1 ? "" : norm(row.c[iJours]);
    if (jtxt && !/^(tous|tous les jours|daily|all|7\/7)$/.test(jtxt)) {
      jours = [];
      const bons = jtxt.split(/[,;\s]+/).filter(Boolean);
      for (let j = 0; j < bons.length; j++) {
        if (JOURS_CODES[bons[j]] === undefined) return err("jour inconnu : « " + bons[j] + " »");
        if (jours.indexOf(JOURS_CODES[bons[j]]) === -1) jours.push(JOURS_CODES[bons[j]]);
      }
    }
    // passages
    const passages = {};
    const ptxt = iPass === -1 ? "" : String(row.c[iPass] || "");
    const pm = ptxt.split("|").map((x) => x.trim()).filter(Boolean);
    for (let j = 0; j < pm.length; j++) {
      const k = pm[j].lastIndexOf("=");
      if (k === -1) return err("passage mal écrit (« Arrêt = HH:MM ») : " + pm[j].slice(0, 30));
      const arret = ligne.arrets.filter((a) => norm(a.nom) === norm(pm[j].slice(0, k)))[0];
      if (!arret) return err("arrêt inconnu dans les passages : « " + pm[j].slice(0, k).trim() + " »");
      const h = heureDe(pm[j].slice(k + 1));
      if (!h) return err("heure de passage invalide pour « " + arret.nom + " »");
      passages[arret.id] = h;
    }
    // quotas
    const quotas = {}; let total = 0;
    const qm = String(row.c[iQuotas] || "").split("|").map((x) => x.trim()).filter(Boolean);
    for (let j = 0; j < qm.length; j++) {
      const k = qm[j].lastIndexOf("=");
      if (k === -1) return err("quota mal écrit (« Classe = places ») : " + qm[j].slice(0, 30));
      const classe = ligne.classes.filter((c) => norm(c.nom) === norm(qm[j].slice(0, k)))[0];
      if (!classe) return err("classe inconnue dans les quotas : « " + qm[j].slice(0, k).trim() + " »");
      const nb = qm[j].slice(k + 1).split("/").map((x) => entier(x));
      if (nb.some((x) => x == null || x > 5000)) return err("nombre de places invalide pour « " + classe.nom + " »");
      if (classe.cote) {
        quotas[classe.id] = nb.length >= 2 ? { fenetre: nb[0], couloir: nb[1] } : { fenetre: Math.ceil(nb[0] / 2), couloir: Math.floor(nb[0] / 2) };
        total += quotas[classe.id].fenetre + quotas[classe.id].couloir;
      } else {
        if (nb.length > 1) return err("la classe « " + classe.nom + " » n'a pas de choix fenêtre / couloir : un seul nombre de places");
        quotas[classe.id] = { total: nb[0] };
        total += nb[0];
      }
    }
    ligne.classes.forEach((c) => { if (!quotas[c.id]) quotas[c.id] = c.cote ? { fenetre: 0, couloir: 0 } : { total: 0 }; });
    if (total < 1) return err("aucune place vendue sur WhatsApp (colonne Quotas)");
    const k = cle(ligne.id, sens, heure);
    if (vus.has(k)) { const lib = ligne.nom + " " + (sens === 1 ? "aller" : "retour") + " " + heure; if (doublons.indexOf(lib) === -1) doublons.push(lib); return; }
    vus.add(k);
    nouveaux.push({ id: "d" + base + "_" + nouveaux.length, ligneId: ligne.id, sens, heure, passages, jours, fermes: [], debut: null, fin: null, actif: true, quotas });
  });
  return { nouveaux, doublons, erreurs };
}

// ---------------- Modeles / exemples a telecharger (train Douala - Yaounde + navette d'aeroport) ----------------
const BOM = "﻿";
const MODELE_LIGNES = BOM + [
  "Ligne;Type;Arrêts;Classes;Tarifs",
  "Douala – Yaoundé;train;Douala (0) > Édéa (66) > Eséka (150) > Yaoundé (263);Premium (fenêtre/couloir) | Première classe (fenêtre/couloir);Premium = 6000 / 11000 | Première classe = 9000 / 15000",
  "Navette aéroport;navette;Aéroport de Douala (0) > Akwa (7) > Bonamoussadi (14);Standard;Standard = 5000 / 9000"
].join("\r\n") + "\r\n";
const MODELE_DEPARTS = BOM + (function () {
  const l = ["Ligne;Sens;Heure;Jours;Passages;Quotas"];
  l.push("Douala – Yaoundé;aller;06:30;tous;Douala=06:30 | Édéa=07:30 | Eséka=09:15 | Yaoundé=11:15;Premium = 20/20 | Première classe = 10/10");
  l.push("Douala – Yaoundé;retour;17:00;tous;Yaoundé=17:00 | Eséka=19:10 | Édéa=20:40 | Douala=21:45;Premium = 20/20 | Première classe = 10/10");
  ["08:00", "12:00", "16:00", "20:00"].forEach((h) => l.push("Navette aéroport;aller;" + h + ";tous;;Standard = 14"));
  ["06:00", "10:00", "14:00", "18:00"].forEach((h) => l.push("Navette aéroport;retour;" + h + ";tous;;Standard = 14"));
  return l.join("\r\n") + "\r\n";
})();

module.exports = { analyserLignes, analyserDeparts, MODELE_LIGNES, MODELE_DEPARTS, norm };
