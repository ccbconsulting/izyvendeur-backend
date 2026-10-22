// IzyVendeur - Etape 80 : estimation de la consommation de messagerie WhatsApp (facturee par Meta), par marchand et par mois.
// Fonctions PURES (sans acces reseau ni base) pour rester testables. Le comptage lui-meme est fait dans server.js (evenements « statuses »
// de Meta) et stocke dans db.js. Tout ceci est reserve au super-administrateur : un marchand ne voit jamais ces chiffres.
//
// Regles de tarification retenues (Meta, a verifier sur la facture : Meta change ses tarifs les 1er janvier, avril, juillet et octobre) :
//   - messages envoyes PAR le client : jamais facturables (ils ne generent aucun evenement « sent » de notre cote) ;
//   - « service » (reponses libres dans la fenetre de 24 h) : `quotaGratuit` messages gratuits par numero et par mois (1 000), puis tarif utilitaire ;
//   - « utility » / « marketing » / « authentication » : factures au message, sauf si Meta indique explicitement billable=false (fenetre d'entree gratuite).
const BAREME_DEFAUT = {
  tarifService: 0.004,           // USD par message au-dela du quota gratuit (Reste de l'Afrique, 1er octobre 2026)
  tarifUtilitaire: 0.004,
  tarifMarketing: 0.0225,
  tarifAuthentification: 0.004,
  quotaGratuit: 1000,            // reponses libres gratuites par numero et par mois
  tauxFcfaParUsd: 600,           // taux de conversion retenu pour l'estimation
  seuilAlerteFcfa: 15000         // au-dela, le marchand est signale « cout eleve »
};
const CHAMPS_BAREME = Object.keys(BAREME_DEFAUT);

function normaliserBareme(b) {
  const out = Object.assign({}, BAREME_DEFAUT);
  if (b && typeof b === "object") CHAMPS_BAREME.forEach((k) => { const v = Number(b[k]); if (b[k] !== undefined && b[k] !== null && b[k] !== "" && Number.isFinite(v) && v >= 0) out[k] = v; });
  if (!(out.tauxFcfaParUsd > 0)) out.tauxFcfaParUsd = BAREME_DEFAUT.tauxFcfaParUsd;
  out.quotaGratuit = Math.floor(out.quotaGratuit);
  return out;
}

// Valide un bareme soumis par le super-administrateur : renvoie { ok, bareme } ou { ok:false, erreur }.
function validerBareme(b) {
  if (!b || typeof b !== "object") return { ok: false, erreur: "Barème invalide." };
  const out = {};
  for (const k of CHAMPS_BAREME) {
    const v = Number(b[k]);
    if (b[k] === undefined || b[k] === null || b[k] === "" || !Number.isFinite(v) || v < 0) return { ok: false, erreur: "Valeur invalide pour « " + k + " »." };
    out[k] = v;
  }
  if (out.tauxFcfaParUsd <= 0 || out.tauxFcfaParUsd > 5000) return { ok: false, erreur: "Le taux FCFA par USD doit être compris entre 1 et 5000." };
  if (out.quotaGratuit > 1000000) return { ok: false, erreur: "Quota gratuit trop grand." };
  out.quotaGratuit = Math.floor(out.quotaGratuit);
  ["tarifService", "tarifUtilitaire", "tarifMarketing", "tarifAuthentification"].forEach((k) => { if (out[k] > 10) out[k] = 10; });
  return { ok: true, bareme: out };
}

// Mois « AAAA-MM » au fuseau de Douala, a partir d'un horodatage Meta (secondes) ou de maintenant.
function moisDouala(timestampSecondes) {
  const ms = Number(timestampSecondes) > 0 ? Number(timestampSecondes) * 1000 : Date.now();
  try { return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Africa/Douala" }).slice(0, 7); } catch (e) { return new Date(ms).toISOString().slice(0, 7); }
}

const CATEGORIES_CONNUES = ["service", "utility", "marketing", "authentication", "authentication_international", "referral_conversion"];
// Categorie annoncee par Meta dans pricing.category (minuscules) ; "inconnu" si Meta n'en donne pas.
function categorieDe(statut) {
  const c = statut && statut.pricing && statut.pricing.category ? String(statut.pricing.category).toLowerCase() : "";
  return CATEGORIES_CONNUES.indexOf(c) !== -1 ? c : "inconnu";
}
// Facturable sauf indication contraire explicite de Meta.
function estFacturable(statut) {
  return !(statut && statut.pricing && statut.pricing.billable === false);
}

// lignes : [{ categorie, nb, nbFacturables }] d'UN marchand pour UN mois -> estimation.
function estimer(lignes, bareme) {
  const b = normaliserBareme(bareme);
  const parCat = {};
  (lignes || []).forEach((l) => { parCat[l.categorie] = { nb: (l.nb || 0), nbFacturables: (l.nbFacturables || 0) }; });
  const nb = (c) => (parCat[c] ? parCat[c].nb : 0);
  const fact = (c) => (parCat[c] ? parCat[c].nbFacturables : 0);
  const service = nb("service") + nb("inconnu");
  const total = Object.keys(parCat).reduce((s, c) => s + parCat[c].nb, 0);
  const serviceFactures = Math.max(0, service - b.quotaGratuit);
  const utilitaire = fact("utility");
  const marketing = fact("marketing") + fact("referral_conversion");
  const auth = fact("authentication") + fact("authentication_international");
  const coutUsd = serviceFactures * b.tarifService + utilitaire * b.tarifUtilitaire + marketing * b.tarifMarketing + auth * b.tarifAuthentification;
  const coutFcfa = Math.round(coutUsd * b.tauxFcfaParUsd);
  let alerte = "ok";
  if (b.quotaGratuit > 0 && service >= b.quotaGratuit * 0.8) alerte = service > b.quotaGratuit ? "depasse" : "proche";
  if (b.seuilAlerteFcfa > 0 && coutFcfa >= b.seuilAlerteFcfa) alerte = "cout_eleve";
  return {
    parCategorie: parCat, total, service, serviceGratuitsRestants: Math.max(0, b.quotaGratuit - service), serviceFactures,
    utilitaireFactures: utilitaire, marketingFactures: marketing, authFactures: auth,
    coutUsd: Math.round(coutUsd * 1000) / 1000, coutFcfa, alerte
  };
}

module.exports = { BAREME_DEFAUT, CHAMPS_BAREME, CATEGORIES_CONNUES, normaliserBareme, validerBareme, moisDouala, categorieDe, estFacturable, estimer };
