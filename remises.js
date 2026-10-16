// Remises (Etape 59) : calcul commun a la Caisse POS et aux factures integrees. Fonctions pures.
//
// Deux niveaux :
//   - remise de LIGNE : { type: "pourcent" | "montant", valeur } sur une ligne (prix unitaire x quantite) ;
//   - remise GLOBALE : meme forme, sur le sous-total (somme des lignes apres remise de ligne).
// Tous les montants sont des FCFA entiers. Le net a payer d'une vente / facture doit rester >= 1 FCFA.
//
// La remise globale est repartie AU PRORATA sur les lignes (le reste d'arrondi va a la derniere ligne non
// nulle), pour que la somme des lignes nettes egale exactement le total : les rapports par article
// continuent de s'additionner juste, sans rien changer cote rapports existants.

function entier(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : NaN;
}

// spec = { type, valeur } -> { type, valeur, montant } ou { erreur }. `base` = montant sur lequel s'applique la remise.
function calculerRemise(base, spec) {
  if (!spec || spec.valeur === undefined || spec.valeur === null || spec.valeur === "") return { montant: 0, type: null, valeur: 0 };
  const type = String(spec.type || "").toLowerCase();
  const valeur = Number(spec.valeur);
  if (!Number.isFinite(valeur) || valeur < 0) return { erreur: "Valeur de remise invalide." };
  if (valeur === 0) return { montant: 0, type: null, valeur: 0 };
  if (type === "pourcent") {
    if (valeur > 100) return { erreur: "Une remise en pourcentage ne peut pas dépasser 100 %." };
    return { type, valeur: Math.round(valeur * 100) / 100, montant: Math.min(base, Math.round(base * valeur / 100)) };
  }
  if (type === "montant") {
    const montant = entier(valeur);
    if (!(montant > 0)) return { erreur: "Valeur de remise invalide." };
    if (montant > base) return { erreur: "La remise (" + montant + " FCFA) dépasse le montant concerné (" + base + " FCFA)." };
    return { type, valeur: montant, montant };
  }
  return { erreur: "Type de remise inconnu (attendu : pourcent ou montant)." };
}

// lignes : [{ brut, remise? }] ; remiseGlobale : spec ou null.
// Renvoie { lignes:[{brut, remiseLigne, net, repartGlobale, final}], brutTotal, remiseLignes, sousTotal,
//           remiseGlobale:{type,valeur,montant}|null, remiseTotale, total, pourcentEffectif } ou { erreur }.
function appliquer(lignes, remiseGlobale) {
  const sortie = [];
  let brutTotal = 0, remiseLignes = 0;
  for (const l of lignes) {
    const brut = entier(l.brut);
    if (!(brut >= 0)) return { erreur: "Montant de ligne invalide." };
    const r = calculerRemise(brut, l.remise);
    if (r.erreur) return { erreur: r.erreur };
    sortie.push({ brut, remiseLigne: r.montant, remiseLigneSpec: r.montant > 0 ? { type: r.type, valeur: r.valeur } : null, net: brut - r.montant, repartGlobale: 0, final: brut - r.montant });
    brutTotal += brut; remiseLignes += r.montant;
  }
  const sousTotal = brutTotal - remiseLignes;
  const g = calculerRemise(sousTotal, remiseGlobale);
  if (g.erreur) return { erreur: g.erreur };
  if (g.montant > 0 && sousTotal > 0) {
    // Repartition au plus grand reste : chaque part reste <= au net de sa ligne et la somme est exacte.
    const exact = sortie.map((l) => g.montant * l.net / sousTotal);
    const parts = exact.map((x) => Math.floor(x));
    let reste = g.montant - parts.reduce((a, b) => a + b, 0);
    exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || b.i - a.i)
      .forEach((o) => { if (reste > 0 && sortie[o.i].net > 0) { parts[o.i] += 1; reste -= 1; } });
    sortie.forEach((l, i) => { l.repartGlobale = parts[i]; l.final = l.net - parts[i]; });
  }
  const remiseTotale = remiseLignes + g.montant;
  const total = brutTotal - remiseTotale;
  if (remiseTotale > 0 && !(total >= 1)) return { erreur: "Le total après remise doit rester supérieur à zéro." };
  return {
    lignes: sortie, brutTotal, remiseLignes, sousTotal,
    remiseGlobale: g.montant > 0 ? { type: g.type, valeur: g.valeur, montant: g.montant } : null,
    remiseTotale, total,
    pourcentEffectif: brutTotal > 0 ? Math.round(remiseTotale * 10000 / brutTotal) / 100 : 0
  };
}

// Aucune remise par defaut : sans plafond explicite fixe par le proprietaire / super-administrateur, le plafond vaut 0 %.
const PLAFOND_PAR_DEFAUT = 0;
function plafondEmploye(valeur) {
  const n = Number(valeur);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : PLAFOND_PAR_DEFAUT;
}

// Controle d'autorisation. `auth` = req.auth ; gestionnaire (proprietaire du marchand ou super-administrateur) : aucun plafond.
// Employe : doit avoir le role "remises" et rester sous son plafond.
function verifierDroit(auth, estGestionnaire, pourcentEffectif) {
  if (estGestionnaire) return null;
  if (!auth || auth.role !== "employe" || (auth.roles || []).indexOf("remises") === -1) {
    return { statut: 403, erreur: "Vous n'avez pas le droit d'accorder des remises." };
  }
  const plafond = plafondEmploye(auth.plafondRemise);
  if (pourcentEffectif > plafond) {
    return { statut: 403, erreur: "Cette remise (" + pourcentEffectif + " %) dépasse votre plafond (" + plafond + " %). Demandez au propriétaire." };
  }
  return null;
}

function motifValide(motif) {
  const m = String(motif == null ? "" : motif).trim().slice(0, 200);
  return m || null;
}

module.exports = { calculerRemise, appliquer, verifierDroit, plafondEmploye, motifValide, PLAFOND_PAR_DEFAUT };
