// IzyVendeur - Journal des mouvements de stock d'UN point (Etape 100). Fonctions PURES (aucun acces disque / reseau).
//
// Pour ne pas grossir sans limite, le journal est AGREGE par jour (jour du Cameroun) et par variante d'article :
//   jours : { "AAAA-MM-JJ": { "<idArticle>|<couleur>|<taille>": { ouv, vente, retour, entree, recu, envoye, ajust } } }
//   noms  : { "<cle>": { nom, reference, categorie, couleur, taille, unite } }   (pour afficher un article meme supprime depuis)
// `ouv` = stock juste AVANT le premier mouvement du jour (= stock de cloture du dernier jour ou l'article a bouge). Les autres champs sont
// des quantites POSITIVES (sauf `ajust`, signe) : vente (sortie en caisse / commande livree), retour (retour client), entree (entree fournisseur),
// recu (transfert recu), envoye (transfert envoye), ajust (correction manuelle du catalogue, import).
// Le rapport de stock d'une periode se deduit de ces jours : initial + entrees + recus + retours - envoyes - ventes + ajustements = restant ;
// toute difference avec le stock reel est montree (« autres ecarts ») au lieu d'etre cachee.

const TYPES = ["vente", "retour", "entree", "recu", "envoye", "ajust"];
const CONSERVATION_JOURS = 800;
const arrondi3 = (x) => Math.round(Number(x) * 1000) / 1000;

function assurer(d) {
  const x = d && typeof d === "object" ? d : {};
  if (!x.jours || typeof x.jours !== "object") x.jours = {};
  if (!x.noms || typeof x.noms !== "object") x.noms = {};
  return x;
}
function cle(productId, couleur, taille) { return productId + "|" + (couleur || "") + "|" + (taille || ""); }

function noter(m, jour, k, info, type, delta, stockAvant) {
  if (TYPES.indexOf(type) === -1) return;
  const d = arrondi3(delta);
  if (!d) return;
  let j = m.jours[jour];
  if (!j) {
    j = m.jours[jour] = {};
    const limite = new Date(Date.parse(jour) - CONSERVATION_JOURS * 86400000).toISOString().slice(0, 10);
    Object.keys(m.jours).forEach((x) => { if (x < limite) delete m.jours[x]; });
  }
  const e = j[k] || (j[k] = { ouv: arrondi3(stockAvant), vente: 0, retour: 0, entree: 0, recu: 0, envoye: 0, ajust: 0 });
  e[type] = arrondi3(e[type] + (type === "ajust" ? d : Math.abs(d)));
  if (info) m.noms[k] = info;
}

// variantes : etat ACTUEL du catalogue [{ cle, nom, reference, categorie, couleur, taille, unite, stock, prixAchat, prix }] ; du / au : AAAA-MM-JJ.
function rapport(m, variantes, du, au) {
  const jours = Object.keys(m.jours).sort();
  const debutJournal = jours.length ? jours[0] : null;
  const actuel = new Map(); variantes.forEach((v) => actuel.set(v.cle, v));
  const cles = new Set(actuel.keys());
  jours.forEach((jr) => { if (jr >= du && jr <= au) Object.keys(m.jours[jr]).forEach((k) => cles.add(k)); });
  const lignes = [];
  const tot = { initial: 0, entree: 0, recu: 0, retour: 0, envoye: 0, vente: 0, ajust: 0, restant: 0, ecart: 0 };
  cles.forEach((k) => {
    const a = actuel.get(k);
    const dansPeriode = jours.filter((jr) => jr >= du && jr <= au && m.jours[jr][k]);
    const apres = jours.filter((jr) => jr > au && m.jours[jr][k])[0];
    const stockFin = apres ? m.jours[apres][k].ouv : (a ? arrondi3(a.stock) : 0);
    const l = { cle: k, initial: 0, entree: 0, recu: 0, retour: 0, envoye: 0, vente: 0, ajust: 0, restant: 0, ecart: 0 };
    if (!dansPeriode.length) { l.initial = stockFin; l.restant = stockFin; }
    else {
      l.initial = m.jours[dansPeriode[0]][k].ouv;
      dansPeriode.forEach((jr) => { const e = m.jours[jr][k]; ["entree", "recu", "retour", "envoye", "vente", "ajust"].forEach((t) => { l[t] = arrondi3(l[t] + e[t]); }); });
      const theorique = arrondi3(l.initial + l.entree + l.recu + l.retour - l.envoye - l.vente + l.ajust);
      l.restant = stockFin;
      l.ecart = arrondi3(stockFin - theorique);
    }
    if (!l.initial && !l.restant && !l.entree && !l.recu && !l.retour && !l.envoye && !l.vente && !l.ajust && !l.ecart) return;
    const info = a || m.noms[k] || {};
    Object.assign(l, { nom: info.nom || k, reference: info.reference || "", categorie: info.categorie || "", couleur: info.couleur || "", taille: info.taille || "", unite: info.unite || "", supprime: !a });
    if (a) { l.prixAchat = a.prixAchat === undefined || a.prixAchat === null || a.prixAchat === "" ? null : Number(a.prixAchat); l.prix = a.prix == null ? null : Number(a.prix); }
    Object.keys(tot).forEach((t) => { tot[t] = arrondi3(tot[t] + l[t]); });
    lignes.push(l);
  });
  lignes.sort((x, y) => (x.categorie || "").localeCompare(y.categorie || "") || x.nom.localeCompare(y.nom) || (x.couleur + x.taille).localeCompare(y.couleur + y.taille));
  return { du, au, debutJournal, avantJournal: debutJournal === null || du < debutJournal, lignes, totaux: tot };
}

module.exports = { TYPES, assurer, cle, noter, rapport, arrondi3 };
