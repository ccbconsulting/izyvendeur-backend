// IzyVendeur - Vente en gros (Etape 78). Fonctions PURES (aucun acces disque / reseau), partagees par le bot WhatsApp
// (conversation.js) et la Caisse POS (server.js).
//
// Donnees stockees dans l'etat du marchand (state.gros) :
//   regles       : [{ id, produitId|null, taille|"", seuil, prix }]
//                  « a partir de `seuil` pieces au TOTAL de la commande (toutes tailles melangees), la piece de cette
//                  taille / de cet article passe a `prix` FCFA ». Specificite : article+taille > article > taille > global.
//   grossistes   : [{ id, nom, telephone, code, note, actif, creeLe }]  (liste privee du proprietaire)
//   criteresCaisse : sous-ensemble de ["nom","code","telephone"] ; semantique « L'un OU l'autre » ; defaut ["code"]
//   Reglages WHATSAPP (choisis par le PROPRIETAIRE, tous faux par defaut) :
//     paliersAuto         : les paliers (a partir de N pieces) s'appliquent aussi a un client NON identifie ; faux = gros reserve aux grossistes identifies
//     tarifsVisibles      : les clients de detail voient les tarifs de gros (ligne de menu, texte « tarifs de gros », astuce « ajoutez N articles »)
//     demanderAuxInconnus : demander « etes-vous grossiste ? » a un client dont le numero n'est pas connu (avant le recapitulatif)
//     devenirGrossiste    : le client peut ecrire « devenir grossiste » (alerte au marchand)
//   caisse : { identification, paliers } reglages de la CAISSE, modifiables par le SEUL super-administrateur (faux par defaut)
//   prochainId   : compteur
//
// Un grossiste ENREGISTRE obtient le prix de gros SANS minimum (meme 1 piece) ; un client ordinaire l'obtient quand le total
// de pieces de sa commande atteint le seuil de la regle. Le prix applique n'est jamais superieur au prix de detail.

const crypto = require("crypto");

const CRITERES_VALIDES = ["nom", "code", "telephone"];
const CRITERES_PAR_DEFAUT = ["code"];
const MAX_REGLES = 200;
const MAX_GROSSISTES = 5000;
const ALPHABET_CODE = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I/L : aucune confusion a la lecture

function donneesParDefaut() {
  return { regles: [], grossistes: [], criteresCaisse: CRITERES_PAR_DEFAUT.slice(), paliersAuto: false, tarifsVisibles: false, demanderAuxInconnus: false, devenirGrossiste: false, caisse: { identification: false, paliers: false }, prochainId: 1 };
}

// Complete / normalise un objet `gros` charge depuis l'etat (retro-compatibilite : absent = valeurs par defaut).
function assurer(gros) {
  const g = gros && typeof gros === "object" ? gros : {};
  if (!Array.isArray(g.regles)) g.regles = [];
  if (!Array.isArray(g.grossistes)) g.grossistes = [];
  g.criteresCaisse = normaliserCriteres(g.criteresCaisse);
  g.paliersAuto = g.paliersAuto === true;
  g.tarifsVisibles = g.tarifsVisibles === true;
  g.demanderAuxInconnus = g.demanderAuxInconnus === true;
  g.devenirGrossiste = g.devenirGrossiste === true;
  if (!g.caisse || typeof g.caisse !== "object") g.caisse = {};
  g.caisse = { identification: g.caisse.identification === true, paliers: g.caisse.paliers === true };
  if (!Number.isInteger(g.prochainId) || g.prochainId < 1) g.prochainId = 1 + g.grossistes.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, "")) || 0), 0);
  return g;
}

function normaliserCriteres(liste) {
  const arr = Array.isArray(liste) ? liste.map((x) => String(x)).filter((x) => CRITERES_VALIDES.indexOf(x) !== -1) : [];
  const uniques = CRITERES_VALIDES.filter((c) => arr.indexOf(c) !== -1); // ordre stable
  return uniques.length ? uniques : CRITERES_PAR_DEFAUT.slice();
}

function sansAccents(s) {
  return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Chiffres seuls ; « 00237... » / « +237... » / « 237... » / « 6... » designent le meme abonne : on compare les 9 derniers chiffres.
function chiffresTelephone(t) {
  let d = String(t == null ? "" : t).replace(/\D/g, "");
  if (d.indexOf("00") === 0) d = d.slice(2);
  return d;
}
function cleTelephone(t) {
  const d = chiffresTelephone(t);
  if (d.length < 8) return "";
  return d.length > 9 ? d.slice(-9) : d;
}
function memeTelephone(a, b) {
  const ka = cleTelephone(a), kb = cleTelephone(b);
  return !!ka && ka === kb;
}

function cleCode(c) { return String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, ""); }

function genererCode(existants) {
  const pris = {};
  (existants || []).forEach((c) => { pris[cleCode(c)] = true; });
  for (let essai = 0; essai < 200; essai++) {
    let s = "";
    for (let i = 0; i < 6; i++) s += ALPHABET_CODE[crypto.randomInt(ALPHABET_CODE.length)];
    if (!pris["G" + s]) return "G-" + s;
  }
  throw new Error("Impossible de generer un code grossiste unique.");
}

// ---------------- Grille de prix ----------------

function entierPositif(v) { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 ? n : NaN; }

// Valide la liste complete des regles envoyee par le proprietaire. produitsConnus : ids du catalogue (null = ne pas verifier).
function validerRegles(entree, produitsConnus) {
  if (!Array.isArray(entree)) return { erreur: "Liste de tarifs invalide." };
  if (entree.length > MAX_REGLES) return { erreur: "Trop de tarifs (maximum " + MAX_REGLES + ")." };
  const out = [];
  const vus = {};
  for (let i = 0; i < entree.length; i++) {
    const r = entree[i] || {};
    const seuil = entierPositif(r.seuil), prix = entierPositif(r.prix);
    if (!Number.isFinite(seuil)) return { erreur: "Tarif " + (i + 1) + " : le nombre minimum de pièces doit être un entier supérieur ou égal à 1." };
    if (!Number.isFinite(prix)) return { erreur: "Tarif " + (i + 1) + " : le prix de gros doit être un entier supérieur ou égal à 1 FCFA." };
    const produitId = r.produitId ? String(r.produitId) : null;
    if (produitId && produitsConnus && produitsConnus.indexOf(produitId) === -1) return { erreur: "Tarif " + (i + 1) + " : article inconnu." };
    const taille = String(r.taille == null ? "" : r.taille).trim().slice(0, 40);
    const cle = (produitId || "") + "|" + sansAccents(taille) + "|" + seuil;
    if (vus[cle]) return { erreur: "Tarif " + (i + 1) + " : doublon (même article, même taille, même minimum)." };
    vus[cle] = true;
    out.push({ id: "r" + (i + 1), produitId, taille, seuil, prix });
  }
  return { regles: out };
}

function specificite(r, item) {
  if (r.produitId && r.produitId !== item.productId) return -1;
  if (r.taille && sansAccents(r.taille) !== sansAccents(item.taille)) return -1;
  return (r.produitId ? 2 : 0) + (r.taille ? 1 : 0);
}

// items : [{ productId, taille, prixDetail, quantite }] ; estGrossiste : grossiste enregistre (aucun minimum) ;
// paliers : les paliers s'appliquent aussi a un client non identifie (faux par defaut : gros reserve aux grossistes).
// Renvoie { prix:[...], appliques:[bool], totalPieces, manque: null|{ pieces, seuil } } .
function tarifer(gros, items, estGrossiste, paliers) {
  const g = assurer(gros);
  const totalPieces = items.reduce((s, it) => s + (Number(it.quantite) || 0), 0);
  const prix = [], appliques = [];
  let manque = null;
  items.forEach((it) => {
    const detail = Number(it.prixDetail) || 0;
    let meilleur = null; // { spec, prix }
    g.regles.forEach((r) => {
      const spec = specificite(r, it);
      if (spec < 0) return;
      const atteint = estGrossiste || (paliers === true && totalPieces >= r.seuil);
      if (!atteint) {
        if (paliers === true && !estGrossiste && r.prix < detail) { const m = r.seuil - totalPieces; if (!manque || m < manque.pieces) manque = { pieces: m, seuil: r.seuil }; }
        return;
      }
      if (!meilleur || spec > meilleur.spec || (spec === meilleur.spec && r.prix < meilleur.prix)) meilleur = { spec, prix: r.prix };
    });
    const final = meilleur ? Math.min(detail, meilleur.prix) : detail;
    prix.push(final);
    appliques.push(final < detail);
  });
  return { prix, appliques, totalPieces, manque };
}

// Libelle d'une regle pour les messages clients : « A partir de 10 pièces — 10 ml : 2 000 FCFA ».
function lignesTarifs(gros, catalogue, fr, formatFcfa, sansSeuil) {
  const g = assurer(gros);
  const noms = {};
  (catalogue || []).forEach((p) => { noms[p.id] = p.nom; });
  let source = g.regles;
  if (sansSeuil) { // une seule ligne par cible : le prix le plus bas
    const m = {};
    source.forEach((r) => { const k = (r.produitId || "") + "|" + sansAccents(r.taille); if (!m[k] || r.prix < m[k].prix) m[k] = r; });
    source = Object.keys(m).map((k) => m[k]);
  }
  const tri = source.slice().sort((a, b) => a.seuil - b.seuil || sansAccents(a.taille).localeCompare(sansAccents(b.taille)) || a.prix - b.prix);
  return tri.map((r) => {
    const cible = [r.produitId ? (noms[r.produitId] || "") : "", r.taille || ""].filter(Boolean).join(" ") || (fr ? "tous articles" : "all items");
    if (sansSeuil) return "• " + cible + " : " + formatFcfa(r.prix);
    return "• " + (fr ? "À partir de " + r.seuil + " pièce" + (r.seuil > 1 ? "s" : "") : "From " + r.seuil + " piece" + (r.seuil > 1 ? "s" : "")) + " — " + cible + " : " + formatFcfa(r.prix);
  });
}

// ---------------- Liste des grossistes ----------------

function nettoyerTexte(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }

function ajouterGrossiste(gros, entree) {
  const g = assurer(gros);
  const nom = nettoyerTexte(entree && entree.nom, 80);
  if (!nom) return { erreur: "Le nom du grossiste est obligatoire." };
  const telRaw = nettoyerTexte(entree && entree.telephone, 25);
  if (telRaw && !cleTelephone(telRaw)) return { erreur: "Numéro de téléphone invalide pour « " + nom + " »." };
  if (telRaw && g.grossistes.some((x) => memeTelephone(x.telephone, telRaw))) return { erreur: "Ce numéro est déjà enregistré pour un autre grossiste." };
  if (g.grossistes.length >= MAX_GROSSISTES) return { erreur: "Nombre maximum de grossistes atteint (" + MAX_GROSSISTES + ")." };
  const grossiste = {
    id: "g" + g.prochainId++,
    nom,
    telephone: telRaw,
    code: genererCode(g.grossistes.map((x) => x.code)),
    note: nettoyerTexte(entree && entree.note, 200),
    actif: !(entree && entree.actif === false),
    creeLe: new Date().toISOString()
  };
  g.grossistes.push(grossiste);
  return { grossiste };
}

function modifierGrossiste(gros, id, patch) {
  const g = assurer(gros);
  const x = g.grossistes.filter((y) => y.id === id)[0];
  if (!x) return { erreur: "Grossiste introuvable." };
  if (patch.nom !== undefined) {
    const nom = nettoyerTexte(patch.nom, 80);
    if (!nom) return { erreur: "Le nom du grossiste est obligatoire." };
    x.nom = nom;
  }
  if (patch.telephone !== undefined) {
    const t = nettoyerTexte(patch.telephone, 25);
    if (t && !cleTelephone(t)) return { erreur: "Numéro de téléphone invalide." };
    if (t && g.grossistes.some((y) => y.id !== id && memeTelephone(y.telephone, t))) return { erreur: "Ce numéro est déjà enregistré pour un autre grossiste." };
    x.telephone = t;
  }
  if (patch.note !== undefined) x.note = nettoyerTexte(patch.note, 200);
  if (patch.actif !== undefined) x.actif = !!patch.actif;
  return { grossiste: x };
}

function retirerGrossiste(gros, id) {
  const g = assurer(gros);
  const i = g.grossistes.findIndex((y) => y.id === id);
  if (i === -1) return { erreur: "Grossiste introuvable." };
  return { grossiste: g.grossistes.splice(i, 1)[0] };
}

function regenererCode(gros, id) {
  const g = assurer(gros);
  const x = g.grossistes.filter((y) => y.id === id)[0];
  if (!x) return { erreur: "Grossiste introuvable." };
  x.code = genererCode(g.grossistes.map((y) => y.code));
  return { grossiste: x };
}

// lignes : [{ nom, telephone, note }] (issues d'un CSV deja decoupe). Les lignes invalides / doublons sont ignorees avec leur motif.
function importerGrossistes(gros, lignes) {
  const g = assurer(gros);
  const ajoutes = [], ignores = [];
  (lignes || []).slice(0, 5000).forEach((l, i) => {
    const r = ajouterGrossiste(g, l || {});
    if (r.erreur) ignores.push({ ligne: i + 1, nom: nettoyerTexte(l && l.nom, 80), motif: r.erreur });
    else ajoutes.push(r.grossiste);
  });
  return { ajoutes, ignores };
}

// ---------------- Recherche ----------------

function trouverParTelephone(gros, tel) {
  const g = assurer(gros);
  if (!cleTelephone(tel)) return null;
  return g.grossistes.filter((x) => x.actif !== false && memeTelephone(x.telephone, tel))[0] || null;
}
function trouverParCode(gros, code) {
  const g = assurer(gros);
  const k = cleCode(code);
  if (k.length < 4) return null;
  return g.grossistes.filter((x) => x.actif !== false && cleCode(x.code) === k)[0] || null;
}

// Caisse : `criteres` (choisis par le proprietaire) = quels champs on compare ; semantique OU. Code et telephone : correspondance
// EXACTE ET COMPLETE ; nom : correspondance partielle (au moins 2 caracteres). Renvoie la liste des grossistes actifs trouves.
function rechercher(gros, saisie, criteres) {
  const g = assurer(gros);
  const crit = normaliserCriteres(criteres);
  const q = nettoyerTexte(saisie, 80);
  if (!q) return [];
  const trouves = [];
  g.grossistes.forEach((x) => {
    if (x.actif === false) return;
    let ok = false;
    if (crit.indexOf("code") !== -1) { const k = cleCode(q); if (k.length >= 4 && k === cleCode(x.code)) ok = true; }
    if (!ok && crit.indexOf("telephone") !== -1 && memeTelephone(q, x.telephone)) ok = true;
    if (!ok && crit.indexOf("nom") !== -1) { const n = sansAccents(q); if (n.length >= 2 && sansAccents(x.nom).indexOf(n) !== -1) ok = true; }
    if (ok) trouves.push(x);
  });
  return trouves.slice(0, 10);
}

module.exports = {
  CRITERES_VALIDES, CRITERES_PAR_DEFAUT, donneesParDefaut, assurer, normaliserCriteres, sansAccents, cleTelephone, memeTelephone, cleCode,
  genererCode, validerRegles, tarifer, lignesTarifs, ajouterGrossiste, modifierGrossiste, retirerGrossiste, regenererCode, importerGrossistes,
  trouverParTelephone, trouverParCode, rechercher
};
