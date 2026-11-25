// IzyVendeur - Transferts de stock entre points de vente d'un meme proprietaire (Etape 95). Fonctions PURES (aucun acces disque / reseau),
// partagees par server.js (routes) et conversation.js (mouvements de stock dans le catalogue d'un point).
//
// Donnees stockees dans l'etat du COMPTE PRINCIPAL du groupe (state.transferts) :
//   bons    : [{ id:"TR-0001", numero, de, vers, statut:"en_transit"|"recu"|"annule", creeLe, creePar, note,
//                lignes:[{ index, productId, nom, reference, categorie, couleur, taille, codeBarres, unite, venteDecimale,
//                          quantiteEnvoyee, quantiteRecue|null, ecart|null, cout|null, prixVenteOrigine, articleCree? }],
//                recuLe, recuPar, motifEcart, ecartTotal, annuleLe, annulePar, motifAnnulation, corrige }]
//   prochain: compteur de numeros
//
// Un bon n'est JAMAIS modifie ni supprime apres sa creation autrement que par ses deux transitions (reception, annulation avant reception) :
// une erreur se corrige par un bon inverse (de B vers A), jamais en reecrivant l'historique.

const MAX_LIGNES = 200;
const MAX_QUANTITE = 1000000;

function arrondi3(x) { return Math.round(Number(x) * 1000) / 1000; }
function normaliser(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim(); }

function assurer(d) {
  const x = d && typeof d === "object" ? d : {};
  if (!Array.isArray(x.bons)) x.bons = [];
  if (!Number.isInteger(x.prochain) || x.prochain < 1) x.prochain = x.bons.length + 1;
  if (!Array.isArray(x.entrees)) x.entrees = []; // Etape 100 : entrees fournisseur (bons EN-0001...)
  if (!Number.isInteger(x.prochainEntree) || x.prochainEntree < 1) x.prochainEntree = x.entrees.length + 1;
  return x;
}
function numeroBon(n) { return "TR-" + String(n).padStart(4, "0"); }
function numeroEntree(n) { return "EN-" + String(n).padStart(4, "0"); }

// Etape 100 - ENTREE FOURNISSEUR : marchandise recue d'un fournisseur. Le PRIX D'ACHAT de chaque ligne est OBLIGATOIRE. Une entree n'est jamais modifiee ni supprimee.
// corps : { fournisseur, bonLivraison, note, lignes:[{ productId, couleur, taille, quantite, prixAchat }] } -> { entree:{...} } ou { erreur, code? }.
function validerEntreeFournisseur(corps) {
  const c = corps && typeof corps === "object" ? corps : {};
  const fournisseur = String(c.fournisseur == null ? "" : c.fournisseur).replace(/\s+/g, " ").trim().slice(0, 80);
  if (fournisseur.length < 2) return { erreur: "Indiquez le fournisseur (2 caractères minimum).", code: "fournisseur_requis" };
  const bonLivraison = String(c.bonLivraison == null ? "" : c.bonLivraison).replace(/\s+/g, " ").trim().slice(0, 40);
  const note = String(c.note == null ? "" : c.note).trim().slice(0, 300);
  const lignes = c.lignes;
  if (!Array.isArray(lignes) || !lignes.length) return { erreur: "Ajoutez au moins un article à l'entrée." };
  if (lignes.length > MAX_LIGNES) return { erreur: "Une entrée ne peut pas dépasser " + MAX_LIGNES + " lignes." };
  const fusion = new Map();
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    if (!l || typeof l !== "object" || typeof l.productId !== "string" || !l.productId) return { erreur: "Ligne " + (i + 1) + " invalide : article manquant." };
    const q = arrondi3(l.quantite);
    if (!Number.isFinite(q) || q <= 0 || q > MAX_QUANTITE) return { erreur: "Ligne " + (i + 1) + " : quantité invalide (nombre positif attendu)." };
    const brut = l.prixAchat;
    const prix = brut === undefined || brut === null || (typeof brut === "string" && brut.trim() === "") ? NaN : Number(brut);
    if (!Number.isFinite(prix) || prix < 0 || prix > 1e9) return { erreur: "Ligne " + (i + 1) + " : le prix d'achat est obligatoire (nombre supérieur ou égal à 0).", code: "prix_achat_requis", ligne: i };
    const couleur = l.couleur == null ? "" : String(l.couleur), taille = l.taille == null ? "" : String(l.taille);
    const k = l.productId + "|" + couleur + "|" + taille;
    if (fusion.has(k)) { const f = fusion.get(k); const total = arrondi3(f.quantite + q); f.prixAchat = Math.round(((f.quantite * f.prixAchat + q * prix) / total) * 100) / 100; f.quantite = total; }
    else fusion.set(k, { productId: l.productId, couleur, taille, quantite: q, prixAchat: Math.round(prix * 100) / 100 });
  }
  return { fournisseur, bonLivraison, note, lignes: Array.from(fusion.values()) };
}

function creerEntree(store, { point, par, fournisseur, bonLivraison, note, lignes }) {
  const numero = store.prochainEntree++;
  const e = {
    id: numeroEntree(numero), numero, point, fournisseur, bonLivraison: bonLivraison || "", note: note || "", creeLe: new Date().toISOString(), creePar: par || "",
    lignes: lignes.map((l, i) => ({
      index: i, productId: l.productId, nom: l.nom, reference: l.reference || "", categorie: l.categorie || "", couleur: l.couleur || "", taille: l.taille || "",
      codeBarres: l.codeBarres || "", unite: l.unite || "", venteDecimale: l.venteDecimale === true, quantite: l.quantite, cout: l.cout, stockAvant: l.stockAvant, stockApres: l.stockApres
    }))
  };
  store.entrees.push(e);
  return e;
}
function valeurEntree(e) { return Math.round(e.lignes.reduce((s, l) => s + (l.cout || 0) * l.quantite, 0)); }
// Vue d'une entree : les couts (prix d'achat saisis) n'existent que pour le proprietaire / super-administrateur.
function vueEntree(e, voirCouts) {
  const c = JSON.parse(JSON.stringify(e));
  c.nbLignes = c.lignes.length;
  c.quantite = arrondi3(c.lignes.reduce((s, l) => s + l.quantite, 0));
  if (voirCouts) c.valeur = valeurEntree(e); else c.lignes.forEach((l) => { delete l.cout; });
  return c;
}

// Valide la demande d'envoi : [{productId, couleur, taille, quantite}] -> lignes fusionnees (meme article = une seule ligne).
function validerLignesDemande(lignes) {
  if (!Array.isArray(lignes) || !lignes.length) return { erreur: "Ajoutez au moins un article au bon de transfert." };
  if (lignes.length > MAX_LIGNES) return { erreur: "Un bon ne peut pas dépasser " + MAX_LIGNES + " lignes." };
  const fusion = new Map();
  for (const l of lignes) {
    if (!l || typeof l !== "object" || typeof l.productId !== "string" || !l.productId) return { erreur: "Ligne invalide : article manquant." };
    const q = arrondi3(l.quantite);
    if (!Number.isFinite(q) || q <= 0 || q > MAX_QUANTITE) return { erreur: "Quantité invalide pour l'article « " + l.productId + " » (nombre positif attendu)." };
    const couleur = l.couleur == null ? "" : String(l.couleur), taille = l.taille == null ? "" : String(l.taille);
    const cle = l.productId + "|" + couleur + "|" + taille;
    if (fusion.has(cle)) fusion.get(cle).quantite = arrondi3(fusion.get(cle).quantite + q);
    else fusion.set(cle, { productId: l.productId, couleur, taille, quantite: q });
  }
  return { lignes: Array.from(fusion.values()) };
}

// Retrouve, dans le catalogue d'un point, l'article correspondant a une ligne de bon : par REFERENCE INTERNE (si renseignee des deux cotes), sinon par NOM
// exact (sans accents ni majuscules) ; puis la variante par couleur / taille. Renvoie { produit, variante } ou { produit, variante:null } ou null.
function trouverArticle(catalogue, ligne) {
  const ref = normaliser(ligne.reference), nom = normaliser(ligne.nom);
  let produit = null;
  if (ref) produit = (catalogue || []).find((p) => normaliser(p.reference) === ref) || null;
  if (!produit && nom) produit = (catalogue || []).find((p) => normaliser(p.nom) === nom) || null;
  if (!produit) return null;
  const c = normaliser(ligne.couleur), t = normaliser(ligne.taille);
  const variante = (produit.variantes || []).find((v) => normaliser(v.couleur) === c && normaliser(v.taille) === t) || null;
  return { produit, variante };
}

// Cout moyen pondere apres une entree en stock : le cout d'origine suit la marchandise (jamais perdu). null = inconnu.
function coutMoyen(stockAvant, coutAvant, quantite, coutEntrant) {
  const ci = Number(coutEntrant);
  if (coutEntrant == null || coutEntrant === "" || !Number.isFinite(ci) || ci < 0) return null; // pas de cout d'origine : on ne touche a rien
  const ca = Number(coutAvant), sa = Number(stockAvant);
  if (coutAvant == null || coutAvant === "" || !Number.isFinite(ca) || !(sa > 0)) return Math.round(ci * 100) / 100;
  return Math.round(((sa * ca + quantite * ci) / (sa + quantite)) * 100) / 100;
}

function creerBon(store, { de, vers, par, lignes, note, corrige }) {
  const numero = store.prochain++;
  const bon = {
    id: numeroBon(numero), numero, de, vers, statut: "en_transit", creeLe: new Date().toISOString(), creePar: par || "", note: String(note || "").slice(0, 300),
    lignes: lignes.map((l, i) => ({
      index: i, productId: l.productId, nom: l.nom, reference: l.reference || "", categorie: l.categorie || "", couleur: l.couleur || "", taille: l.taille || "",
      codeBarres: l.codeBarres || "", unite: l.unite || "", venteDecimale: l.venteDecimale === true, quantiteEnvoyee: l.quantite, quantiteRecue: null, ecart: null,
      cout: l.cout == null ? null : l.cout, prixVenteOrigine: l.prixVenteOrigine == null ? null : l.prixVenteOrigine
    })),
    recuLe: null, recuPar: null, motifEcart: "", ecartTotal: null, annuleLe: null, annulePar: null, motifAnnulation: "", corrige: corrige || null
  };
  store.bons.push(bon);
  return bon;
}

// Vue d'un bon : les couts n'existent que pour le proprietaire / super-administrateur (jamais pour un magasinier).
function vueBon(bon, voirCouts) {
  const c = JSON.parse(JSON.stringify(bon));
  c.nbLignes = c.lignes.length;
  c.quantiteEnvoyee = arrondi3(c.lignes.reduce((s, l) => s + l.quantiteEnvoyee, 0));
  if (!voirCouts) c.lignes.forEach((l) => { delete l.cout; delete l.prixVenteOrigine; });
  else c.valeur = valeurBon(bon);
  return c;
}
function valeurBon(bon) {
  let v = 0, connu = false;
  bon.lignes.forEach((l) => { if (l.cout != null) { v += l.cout * l.quantiteEnvoyee; connu = true; } });
  return connu ? Math.round(v) : null;
}

function jourCameroun(iso) { return new Date(Date.parse(iso) + 3600000).toISOString().slice(0, 10); }
function periode(du, au) {
  const aujourdhui = jourCameroun(new Date().toISOString());
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const d = du === undefined || du === "" ? jourCameroun(new Date(Date.now() - 29 * 86400000).toISOString()) : du;
  const a = au === undefined || au === "" ? aujourdhui : au;
  if (!re.test(d) || !re.test(a) || isNaN(Date.parse(d)) || isNaN(Date.parse(a))) return { erreur: "Dates invalides (format AAAA-MM-JJ attendu)." };
  if (d > a) return { erreur: "La date de début doit précéder la date de fin." };
  return { du: d, au: a };
}

// Rapport des mouvements : par point (envoye / recu / ecarts / en transit) sur la periode (date de creation du bon), valeurs au cout d'origine si connu.
function rapportMouvements(bons, points, du, au) {
  const par = {}; points.forEach((p) => { par[p.id] = { id: p.id, nom: p.nom, envoye: { nbBons: 0, quantite: 0, valeur: 0 }, recu: { nbBons: 0, quantite: 0 }, ecart: { quantite: 0, valeur: 0 }, enTransit: { nbBons: 0, quantite: 0 }, annule: { nbBons: 0 } }; });
  const selection = bons.filter((b) => { const j = jourCameroun(b.creeLe); return j >= du && j <= au; });
  const total = { nbBons: selection.length, enTransit: 0, recus: 0, annules: 0, ecartQuantite: 0, ecartValeur: 0 };
  selection.forEach((b) => {
    const o = par[b.de], d = par[b.vers];
    if (b.statut === "annule") { if (o) o.annule.nbBons++; total.annules++; return; }
    const qEnv = arrondi3(b.lignes.reduce((s, l) => s + l.quantiteEnvoyee, 0));
    const val = valeurBon(b) || 0;
    if (o) { o.envoye.nbBons++; o.envoye.quantite = arrondi3(o.envoye.quantite + qEnv); o.envoye.valeur += val; }
    if (b.statut === "en_transit") { if (d) { d.enTransit.nbBons++; d.enTransit.quantite = arrondi3(d.enTransit.quantite + qEnv); } total.enTransit++; return; }
    total.recus++;
    const qRec = arrondi3(b.lignes.reduce((s, l) => s + (l.quantiteRecue || 0), 0));
    if (d) { d.recu.nbBons++; d.recu.quantite = arrondi3(d.recu.quantite + qRec); }
    b.lignes.forEach((l) => {
      const e = l.ecart || 0; if (!e) return;
      if (o) { o.ecart.quantite = arrondi3(o.ecart.quantite + e); if (l.cout != null) o.ecart.valeur += Math.round(l.cout * e); }
      total.ecartQuantite = arrondi3(total.ecartQuantite + e); if (l.cout != null) total.ecartValeur += Math.round(l.cout * e);
    });
  });
  return { points: points.map((p) => par[p.id]), total, nbBons: selection.length };
}

module.exports = { numeroEntree, validerEntreeFournisseur, creerEntree, vueEntree, valeurEntree, MAX_LIGNES, arrondi3, normaliser, assurer, numeroBon, validerLignesDemande, trouverArticle, coutMoyen, creerBon, vueBon, valeurBon, jourCameroun, periode, rapportMouvements };
