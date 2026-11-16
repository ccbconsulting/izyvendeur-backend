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
  return x;
}
function numeroBon(n) { return "TR-" + String(n).padStart(4, "0"); }

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

module.exports = { MAX_LIGNES, arrondi3, normaliser, assurer, numeroBon, validerLignesDemande, trouverArticle, coutMoyen, creerBon, vueBon, valeurBon, jourCameroun, periode, rapportMouvements };
