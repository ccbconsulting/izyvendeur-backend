// Etape 88 : paiement mixte de la Caisse (plusieurs moyens de paiement pour une meme vente) et rendu de monnaie.
//
// Principe additif : une vente a UN seul moyen garde exactement la forme historique (order.modePaiement + order.referencePaiement).
// Une vente payee avec PLUSIEURS moyens porte order.modePaiement = "mixte" et order.paiements = [{ mode, montant, reference }],
// ou « montant » est la part reellement imputee a la vente (jamais le billet tendu) : la somme des parts = le total de la vente.
// Pour la part en especes, « recu » (billets tendus) et « rendu » (monnaie rendue) sont conserves pour le ticket.
const MODES = ["especes", "om", "momo", "carte", "cheque"];
const MAX_PAIEMENTS = 6;

// Ventilation d'une vente par moyen de paiement, quelle que soit son age : [{ mode, montant, reference }].
function repartition(order) {
  if (!order) return [];
  // Etape 90 : vente avec une part A CREDIT : seules les parts reellement encaissees (order.paiements, eventuellement vide) sont des paiements.
  if (order.creance) return (Array.isArray(order.paiements) ? order.paiements : []).map((p) => ({ mode: MODES.indexOf(p.mode) !== -1 ? p.mode : "especes", montant: Number(p.montant) || 0, reference: p.reference || null }));
  if (Array.isArray(order.paiements) && order.paiements.length) {
    return order.paiements.map((p) => ({ mode: MODES.indexOf(p.mode) !== -1 ? p.mode : "especes", montant: Number(p.montant) || 0, reference: p.reference || null }));
  }
  return [{ mode: MODES.indexOf(order.modePaiement) !== -1 ? order.modePaiement : "especes", montant: Number(order.prix) || 0, reference: order.referencePaiement || null }];
}

// Part en especes d'une vente (ce qui entre dans le tiroir-caisse).
function partEspeces(order) {
  return repartition(order).filter((p) => p.mode === "especes").reduce((s, p) => s + p.montant, 0);
}

// Valide la saisie « paiements » d'une vente de total connu. Renvoie { paiements, rendu, recu } (parts imputees) ou { erreur }.
function normaliser(saisie, total) {
  if (!Array.isArray(saisie) || !saisie.length) return { erreur: "Aucun paiement saisi." };
  if (saisie.length > MAX_PAIEMENTS) return { erreur: "Trop de lignes de paiement (maximum " + MAX_PAIEMENTS + ")." };
  const electroniques = [];
  let recu = 0, nbEspeces = 0;
  for (const p of saisie) {
    const mode = p && p.mode;
    if (MODES.indexOf(mode) === -1) return { erreur: "Mode de paiement invalide (attendu : " + MODES.join("/") + ")." };
    const montant = Number(p.montant);
    if (!Number.isInteger(montant) || montant <= 0) return { erreur: "Chaque paiement doit avoir un montant entier supérieur à 0." };
    if (mode === "especes") {
      nbEspeces++;
      recu += montant;
    } else {
      const reference = (p.reference || "").toString().trim().slice(0, 80);
      if (!reference) return { erreur: "La référence de paiement est obligatoire pour ce mode de paiement." };
      electroniques.push({ mode, montant, reference });
    }
  }
  if (nbEspeces > 1) return { erreur: "Une seule ligne de paiement en espèces est autorisée." };
  const totalElectronique = electroniques.reduce((s, p) => s + p.montant, 0);
  if (totalElectronique > total) return { erreur: "Les paiements hors espèces (" + totalElectronique + " FCFA) dépassent le total de la vente (" + total + " FCFA)." };
  const especesDues = total - totalElectronique;
  if (especesDues === 0 && recu > 0) return { erreur: "Le total est déjà couvert : retirez la ligne en espèces." };
  if (recu < especesDues) return { erreur: "Paiement insuffisant : il manque " + (especesDues - recu) + " FCFA." };
  const paiements = [];
  if (especesDues > 0) paiements.push({ mode: "especes", montant: especesDues, reference: null, recu, rendu: recu - especesDues });
  electroniques.forEach((p) => paiements.push(p));
  return { paiements, rendu: recu - especesDues, recu };
}

module.exports = { MODES, MAX_PAIEMENTS, repartition, partEspeces, normaliser };
