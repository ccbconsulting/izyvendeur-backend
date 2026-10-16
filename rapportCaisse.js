// Rapport de caisse (Etape 58) : synthese des ventes de la Caisse POS et des sessions de caisse sur une
// PERIODE LIBRE (du / au), filtrable par caissier. Fonction pure : server.js lui fournit les commandes et
// les sessions du moteur catalogue, elle ne touche a aucun etat.
//
// Regles de lecture (a connaitre) :
// - Une vente appartient a la journee de sa creation (heure du Cameroun, UTC+1, comme le journal comptable).
// - Une vente dont la commande est "Annulée" est comptee a part (colonne « annulé »), jamais dans le net.
// - Une vente POS ensuite facturee reste une vente de caisse (l'argent est bien passe par la caisse) ; elle est
//   seulement signalee « facturée » dans le detail. Le journal comptable, lui, la remplace par la facture.
// - Une session appartient a la journee de son OUVERTURE. Son montant theorique et son ecart sont ceux figes a
//   la fermeture (voir fermerSessionCaisse) ; on ajoute les ventes en especes annulees depuis, pour que le
//   lecteur puisse reconstituer un ecart.
const MODES = ["especes", "om", "momo", "carte", "cheque"];
const JOURS_MAX = 366;

function dateLocale(d) {
  return new Date((d ? new Date(d).getTime() : Date.now()) + 3600 * 1000).toISOString().slice(0, 10);
}
function heureLocale(d) {
  return new Date(new Date(d).getTime() + 3600 * 1000).toISOString().slice(11, 16);
}
function valide(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) return false;
  const t = new Date(d + "T00:00:00Z");
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; // refuse le 31 fevrier (sinon decale au 3 mars)
}
function joursEntre(du, au) { return Math.round((new Date(au + "T00:00:00Z") - new Date(du + "T00:00:00Z")) / 86400000); }

function normaliserPeriode(du, au) {
  const aujourdhui = dateLocale();
  const d1 = du ? String(du) : null, d2 = au ? String(au) : null;
  if ((d1 && !valide(d1)) || (d2 && !valide(d2))) return { erreur: "Dates invalides (format attendu : AAAA-MM-JJ)." };
  const fin = d2 || d1 || aujourdhui;
  const debut = d1 || fin;
  if (debut > fin) return { erreur: "La date de début doit précéder la date de fin." };
  if (joursEntre(debut, fin) + 1 > JOURS_MAX) return { erreur: "Période trop longue (maximum " + JOURS_MAX + " jours)." };
  return { du: debut, au: fin };
}

function libelleArticle(it) {
  const v = [it.couleur, it.taille].map((x) => String(x == null ? "" : x).trim()).filter((x) => x && x !== "-").join("/");
  return it.produit + (v ? " (" + v + ")" : "");
}

function genererRapportCaisse({ marchand, commandes, sessions, du, au, caissier }) {
  const p = normaliserPeriode(du, au);
  if (p.erreur) return p;
  const filtreCaissier = caissier ? String(caissier) : null;
  const toutesPos = (commandes || []).filter((o) => o && o.source === "pos");
  const caissiers = Array.from(new Set(
    toutesPos.map((o) => o.caissier).concat((sessions || []).map((s) => s.caissier)).filter(Boolean)
  )).sort();

  const ventes = toutesPos
    .filter((o) => { const j = dateLocale(o.dateISO); return j >= p.du && j <= p.au && (!filtreCaissier || o.caissier === filtreCaissier); })
    .sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.id - b.id));

  const parMode = {}; MODES.forEach((m) => { parMode[m] = { mode: m, nb: 0, montant: 0, nbAnnulees: 0, montantAnnule: 0 }; });
  const parJour = {}, parCaissier = {}, articles = {};
  const totaux = { nbVentes: 0, brut: 0, nbAnnulees: 0, montantAnnule: 0, net: 0, nbArticles: 0, nbFacturees: 0 };
  const jour = (d) => parJour[d] || (parJour[d] = { date: d, nb: 0, net: 0, nbAnnulees: 0, annule: 0, especes: 0, om: 0, momo: 0, carte: 0, cheque: 0 });
  const cais = (c) => { const k = c || "—"; return parCaissier[k] || (parCaissier[k] = { caissier: k, nb: 0, net: 0, nbAnnulees: 0, annule: 0 }); };

  const detail = ventes.map((o) => {
    const montant = Number(o.prix) || 0;
    const annulee = o.statut === "Annulée";
    const mode = parMode[o.modePaiement] ? o.modePaiement : "especes";
    const d = dateLocale(o.dateISO);
    const J = jour(d), C = cais(o.caissier);
    totaux.brut += montant;
    if (annulee) {
      totaux.nbAnnulees++; totaux.montantAnnule += montant;
      parMode[mode].nbAnnulees++; parMode[mode].montantAnnule += montant;
      J.nbAnnulees++; J.annule += montant; C.nbAnnulees++; C.annule += montant;
    } else {
      totaux.nbVentes++; totaux.net += montant;
      parMode[mode].nb++; parMode[mode].montant += montant;
      J.nb++; J.net += montant; J[mode] += montant; C.nb++; C.net += montant;
      if (o.izyfactureNumero) totaux.nbFacturees++;
      (o.items || []).forEach((it) => {
        const k = libelleArticle(it);
        const a = articles[k] || (articles[k] = { article: k, quantite: 0, montant: 0 });
        a.quantite += Number(it.quantite) || 0; a.montant += Number(it.prix) || 0;
        totaux.nbArticles += Number(it.quantite) || 0;
      });
    }
    return {
      id: o.id, piece: "POS-" + String(o.id).padStart(4, "0"), date: d, heure: heureLocale(o.dateISO),
      sessionId: o.sessionCaisseId != null ? o.sessionCaisseId : null, caissier: o.caissier || null,
      mode, reference: o.referencePaiement || null, montant, statut: annulee ? "annulee" : "valide",
      raisonAnnulation: annulee ? (o.raisonAnnulation || null) : null,
      facture: o.izyfactureNumero || null,
      articles: (o.items || []).map((it) => (Number(it.quantite) || 0) + " x " + libelleArticle(it)).join(" ; ")
    };
  });
  totaux.panierMoyen = totaux.nbVentes ? Math.round(totaux.net / totaux.nbVentes) : 0;

  // Sessions ouvertes pendant la periode (jour d'ouverture), du caissier filtre le cas echeant.
  const annuleesParSession = {};
  toutesPos.filter((o) => o.statut === "Annulée" && o.modePaiement === "especes" && o.sessionCaisseId != null)
    .forEach((o) => { annuleesParSession[o.sessionCaisseId] = (annuleesParSession[o.sessionCaisseId] || 0) + (Number(o.prix) || 0); });
  const lesSessions = (sessions || [])
    .filter((s) => { const j = dateLocale(s.dateOuverture); return j >= p.du && j <= p.au && (!filtreCaissier || s.caissier === filtreCaissier); })
    .sort((a, b) => (a.dateOuverture < b.dateOuverture ? -1 : 1))
    .map((s) => ({
      id: s.id, caissier: s.caissier || null, statut: s.statut,
      dateOuverture: s.dateOuverture, dateFermeture: s.dateFermeture || null,
      fondInitial: s.fondInitial, totalVentesEspeces: s.totalVentesEspeces, montantTheorique: s.montantTheorique,
      montantCompte: s.montantCompte, ecart: s.ecart, raisonEcart: s.raisonEcart || null,
      especesAnnulees: annuleesParSession[s.id] || 0
    }));
  const fermees = lesSessions.filter((s) => s.statut === "fermee");
  const ecarts = {
    nbSessions: lesSessions.length, nbFermees: fermees.length, nbOuvertes: lesSessions.length - fermees.length,
    nbAvecEcart: fermees.filter((s) => s.ecart !== 0).length,
    totalEcart: fermees.reduce((s, x) => s + (x.ecart || 0), 0),
    totalFond: lesSessions.reduce((s, x) => s + (x.fondInitial || 0), 0)
  };

  // Tous les jours de la periode apparaissent (meme sans vente) : lecture continue d'un mois ou d'une semaine.
  const jours = [];
  for (let d = new Date(p.du + "T00:00:00Z"); d.toISOString().slice(0, 10) <= p.au; d = new Date(d.getTime() + 86400000)) jours.push(jour(d.toISOString().slice(0, 10)));
  jours.sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    marchand, du: p.du, au: p.au, caissier: filtreCaissier, caissiers, genereLe: new Date().toISOString(),
    totaux, parMode: MODES.map((m) => parMode[m]), parJour: jours,
    parCaissier: Object.keys(parCaissier).sort().map((k) => parCaissier[k]),
    articles: Object.keys(articles).map((k) => articles[k]).sort((a, b) => b.montant - a.montant || (a.article < b.article ? -1 : 1)),
    sessions: lesSessions, ecarts, ventes: detail
  };
}

// --- CSV (point-virgule par defaut pour Excel en francais ; BOM UTF-8) ---
const VUES_CSV = ["synthese", "ventes", "sessions"];
function csv(rapport, vue, sep) {
  const s0 = sep === "," ? "," : ";";
  const echapper = (v) => {
    const s = v == null ? "" : String(v);
    return /[";,\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  let colonnes, lignes;
  if (vue === "ventes") {
    colonnes = ["piece", "date", "heure", "session", "caissier", "mode", "reference", "montant", "statut", "raisonAnnulation", "facture", "articles"];
    lignes = rapport.ventes.map((v) => [v.piece, v.date, v.heure, v.sessionId, v.caissier, v.mode, v.reference, v.montant, v.statut, v.raisonAnnulation, v.facture, v.articles]);
  } else if (vue === "sessions") {
    colonnes = ["session", "caissier", "statut", "ouverture", "fermeture", "fondInitial", "ventesEspeces", "montantTheorique", "montantCompte", "ecart", "raisonEcart", "especesAnnulees"];
    lignes = rapport.sessions.map((x) => [x.id, x.caissier, x.statut, x.dateOuverture, x.dateFermeture, x.fondInitial, x.totalVentesEspeces, x.montantTheorique, x.montantCompte, x.ecart, x.raisonEcart, x.especesAnnulees]);
  } else {
    colonnes = ["date", "nbVentes", "especes", "om", "momo", "carte", "cheque", "totalNet", "nbAnnulees", "montantAnnule"];
    lignes = rapport.parJour.map((j) => [j.date, j.nb, j.especes, j.om, j.momo, j.carte, j.cheque, j.net, j.nbAnnulees, j.annule]);
    lignes.push(["TOTAL", rapport.totaux.nbVentes].concat(rapport.parMode.map((m) => m.montant), [rapport.totaux.net, rapport.totaux.nbAnnulees, rapport.totaux.montantAnnule]));
  }
  return "﻿" + [colonnes.join(s0)].concat(lignes.map((l) => l.map(echapper).join(s0))).join("\r\n") + "\r\n";
}

module.exports = { genererRapportCaisse, csv, normaliserPeriode, VUES_CSV, MODES, JOURS_MAX };
