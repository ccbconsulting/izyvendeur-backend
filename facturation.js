// IzyVendeur - Moteur de facturation INTEGREE (Etapes 54-56).
//
// Module volontairement SIMPLE : factures, avoirs, paiements (avec recu numerote), depenses, et un journal
// normalise exportable. Ce n'est PAS une comptabilite : aucun plan comptable, aucune TVA calculee (les prix
// sont TTC, comme dans le pont IzyFacture : pricesIncludeTax = true). La comptabilite reste dans IzyCompta,
// application separee qui IMPORTE le journal normalise (voir journal() ci-dessous) sans jamais ressaisir.
//
// Le choix de la source de facturation d'un marchand (aucune / integree / IzyFacture) n'est PAS decide ici :
// c'est server.js qui le tient, reserve au super-administrateur. Ce module ne fait que stocker et calculer.
//
// Persistance : un etat JSON par marchand, range sous la cle "<idMarchand>__facturation" dans le meme
// mecanisme que l'etat des commandes (db.initMerchantState / persistMerchantState : PostgreSQL en production,
// data.json en local). Aucune colonne ajoutee a la table des marchands.
//
// Regles de non-alteration (comme pour une vraie facturation) : on ne supprime JAMAIS une facture ni un
// paiement. Une erreur se corrige par un avoir (facture) ou par une annulation tracee (depense). Les numeros
// ne sont jamais reutilises.

const crypto = require("crypto");
const db = require("./db");

const SOURCE_JOURNAL = "izyvendeur-interne";
const METHODES = ["especes", "om", "momo", "banque", "cheque", "autre"];
const CATEGORIES_DEPENSE = ["achat_marchandises", "transport", "loyer", "salaires", "electricite_eau", "telecom", "publicite", "entretien", "taxes", "autre"];

// Date locale Cameroun (Africa/Douala = UTC+1 toute l'annee, pas d'heure d'ete).
function dateLocale(d) {
  return new Date((d ? new Date(d).getTime() : Date.now()) + 3600 * 1000).toISOString().slice(0, 10);
}
function annee(d) { return dateLocale(d).slice(0, 4); }

function entier(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : NaN;
}

function etatInitial() {
  return {
    config: { interne: false, autoFacturation: false, dateActivation: null, dateBascule: null, basculeLe: null, basculePar: null },
    compteurs: {},
    factures: [],
    depenses: [],
    prochainId: { facture: 1, depense: 1, paiement: 1, avoir: 1 }
  };
}

function creerMoteurFacturation(merchantKey, options) {
  const cleEtat = merchantKey + "__facturation";
  const persister = (options && options.persister) || ((etat) => db.persistMerchantState(cleEtat, etat));
  let state = null;

  async function init() {
    state = await db.initMerchantState(cleEtat, etatInitial);
    const base = etatInitial();
    if (!state.config) state.config = base.config;
    if (!state.compteurs) state.compteurs = {};
    if (!state.factures) state.factures = [];
    if (!state.depenses) state.depenses = [];
    if (!state.prochainId) state.prochainId = base.prochainId;
  }

  function sauver() {
    if (!state) return;
    Promise.resolve(persister(state)).catch((erreur) => {
      console.error("[" + merchantKey + "] Erreur de sauvegarde de la facturation integree (derniere modification peut-etre perdue) :", erreur);
    });
  }

  // Prochain numero d'une serie, remis a 1 chaque annee civile (FV-2026-0001). Jamais reutilise.
  function numeroSuivant(prefixe, dateIso) {
    const cle = prefixe + "-" + annee(dateIso);
    state.compteurs[cle] = (state.compteurs[cle] || 0) + 1;
    return cle + "-" + String(state.compteurs[cle]).padStart(4, "0");
  }
  function idSuivant(type) {
    const n = state.prochainId[type] || 1;
    state.prochainId[type] = n + 1;
    return n;
  }

  // ---- Calculs derives (jamais stockes : un seul endroit de verite) ----
  function totalPaye(f) { return f.paiements.reduce((s, p) => s + p.montant, 0); }
  function totalAvoirs(f) { return f.avoirs.reduce((s, a) => s + a.montant, 0); }
  function vue(f) {
    const paye = totalPaye(f);
    const avoirs = totalAvoirs(f);
    const net = f.total - avoirs;
    const solde = Math.max(0, net - paye);
    const aRembourser = Math.max(0, paye - net);
    let statut;
    if (avoirs >= f.total) statut = "avoir";
    else if (solde === 0) statut = "paid";
    else if (paye > 0) statut = "partially_paid";
    else statut = "issued";
    return Object.assign({}, f, { paye, totalAvoirs: avoirs, net, solde, aRembourser, statut });
  }

  function nettoyerTexte(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }

  function nettoyerLignes(lignes) {
    if (!Array.isArray(lignes) || !lignes.length) return { erreur: "Ajoutez au moins une ligne à la facture." };
    if (lignes.length > 100) return { erreur: "Trop de lignes (100 maximum)." };
    const sortie = [];
    for (const l of lignes) {
      const designation = nettoyerTexte(l && (l.designation || l.desc), 200);
      const quantite = entier(l && (l.quantite != null ? l.quantite : l.qty));
      const prixUnitaire = entier(l && (l.prixUnitaire != null ? l.prixUnitaire : l.price));
      if (!designation) return { erreur: "Chaque ligne doit avoir une désignation." };
      if (!(quantite > 0)) return { erreur: "Quantité invalide sur « " + designation + " »." };
      if (!(prixUnitaire >= 0)) return { erreur: "Prix invalide sur « " + designation + " »." };
      sortie.push({ designation, quantite, prixUnitaire, total: quantite * prixUnitaire });
    }
    return { lignes: sortie };
  }

  // ---- Factures ----
  // `origine` = { type: "commande" | "rdv" | "libre", id } ; `externalRef` (facultatif) rend l'operation
  // idempotente : refaire la meme demande renvoie la facture existante (duplicate = true), jamais un doublon.
  function creerFacture(p) {
    const net = nettoyerLignes(p.lignes);
    if (net.erreur) return { erreur: net.erreur };
    const total = net.lignes.reduce((s, l) => s + l.total, 0);
    if (!(total > 0)) return { erreur: "Le total de la facture doit être supérieur à zéro." };
    if (p.externalRef) {
      const existante = state.factures.find((f) => f.externalRef === p.externalRef);
      if (existante) return { facture: vue(existante), duplicate: true };
    }
    const maintenant = new Date().toISOString();
    const f = {
      id: idSuivant("facture"),
      numero: numeroSuivant("FV", maintenant),
      token: crypto.randomBytes(16).toString("hex"),
      creeLe: maintenant,
      date: dateLocale(maintenant),
      client: { nom: nettoyerTexte(p.client && p.client.nom, 120) || "Client", telephone: nettoyerTexte(p.client && p.client.telephone, 30) || null },
      lignes: net.lignes,
      total,
      notes: nettoyerTexte(p.notes, 500) || null,
      origine: { type: (p.origine && p.origine.type) || "libre", id: p.origine && p.origine.id != null ? p.origine.id : null },
      externalRef: p.externalRef || null,
      creePar: nettoyerTexte(p.creePar, 80) || null,
      paiements: [],
      avoirs: []
    };
    state.factures.push(f);
    sauver();
    return { facture: vue(f), duplicate: false };
  }

  function trouver(id) { return state.factures.find((f) => f.id === Number(id)) || null; }

  function enregistrerPaiement(factureId, p) {
    const f = trouver(factureId);
    if (!f) return { erreur: "Facture introuvable.", statut: 404 };
    const v = vue(f);
    if (v.statut === "avoir") return { erreur: "Cette facture est entièrement annulée par un avoir.", statut: 400 };
    const montant = entier(p.montant);
    if (!(montant > 0)) return { erreur: "Montant invalide : indiquez un nombre de FCFA supérieur à zéro.", statut: 400 };
    if (montant > v.solde) return { erreur: "Le montant dépasse le solde restant (" + v.solde + " FCFA).", statut: 400 };
    const methode = nettoyerTexte(p.methode || "especes", 20).toLowerCase();
    if (METHODES.indexOf(methode) === -1) return { erreur: "Mode de paiement inconnu : " + methode + ".", statut: 400 };
    const maintenant = new Date().toISOString();
    const paiement = {
      id: idSuivant("paiement"),
      recuNumero: numeroSuivant("RV", maintenant),
      montant, methode,
      reference: nettoyerTexte(p.reference, 80) || null,
      date: maintenant,
      creePar: nettoyerTexte(p.creePar, 80) || null
    };
    f.paiements.push(paiement);
    sauver();
    return { facture: vue(f), paiement };
  }

  // Avoir (total par defaut, partiel si `montant` est donne). Plafonne au montant encore "avoirable".
  function creerAvoir(factureId, p) {
    const f = trouver(factureId);
    if (!f) return { erreur: "Facture introuvable.", statut: 404 };
    const restant = f.total - totalAvoirs(f);
    if (restant <= 0) return { erreur: "Cette facture est déjà entièrement annulée par un avoir.", statut: 400 };
    const montant = p.montant === undefined || p.montant === null || p.montant === "" ? restant : entier(p.montant);
    if (!(montant > 0)) return { erreur: "Montant d'avoir invalide.", statut: 400 };
    if (montant > restant) return { erreur: "L'avoir dépasse le montant restant à créditer (" + restant + " FCFA).", statut: 400 };
    const maintenant = new Date().toISOString();
    const avoir = {
      id: idSuivant("avoir"),
      numero: numeroSuivant("AV", maintenant),
      montant,
      motif: nettoyerTexte(p.motif, 300) || "Annulation",
      date: maintenant,
      creePar: nettoyerTexte(p.creePar, 80) || null
    };
    f.avoirs.push(avoir);
    sauver();
    return { facture: vue(f), avoir };
  }

  function listeFactures() { return state.factures.map(vue).sort((a, b) => b.id - a.id); }
  function factureParId(id) { const f = trouver(id); return f ? vue(f) : null; }
  function factureParToken(token) {
    if (!token || typeof token !== "string" || token.length < 16) return null;
    const f = state.factures.find((x) => x.token === token);
    return f ? vue(f) : null;
  }
  function factureParExternalRef(ref) { const f = state.factures.find((x) => x.externalRef === ref); return f ? vue(f) : null; }

  // ---- Depenses (Etape 55) ----
  function creerDepense(p) {
    const montant = entier(p.montant);
    if (!(montant > 0)) return { erreur: "Montant invalide : indiquez un nombre de FCFA supérieur à zéro." };
    const categorie = nettoyerTexte(p.categorie || "autre", 40);
    if (CATEGORIES_DEPENSE.indexOf(categorie) === -1) return { erreur: "Catégorie de dépense inconnue : " + categorie + "." };
    const methode = nettoyerTexte(p.methode || "especes", 20).toLowerCase();
    if (METHODES.indexOf(methode) === -1) return { erreur: "Mode de paiement inconnu : " + methode + "." };
    let date = nettoyerTexte(p.date, 10) || dateLocale();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + "T00:00:00Z").getTime())) return { erreur: "Date invalide (format AAAA-MM-JJ)." };
    if (date > dateLocale()) return { erreur: "Une dépense ne peut pas être datée dans le futur." };
    const maintenant = new Date().toISOString();
    const d = {
      id: idSuivant("depense"),
      numero: numeroSuivant("DEP", date),
      date, categorie, montant, methode,
      fournisseur: nettoyerTexte(p.fournisseur, 120) || null,
      note: nettoyerTexte(p.note, 300) || null,
      justificatif: nettoyerTexte(p.justificatif, 120) || null, // simple reference de piece (pas de fichier)
      creeLe: maintenant,
      creePar: nettoyerTexte(p.creePar, 80) || null,
      annulee: false, annuleeLe: null, motifAnnulation: null
    };
    state.depenses.push(d);
    sauver();
    return { depense: d };
  }

  function annulerDepense(id, p) {
    const d = state.depenses.find((x) => x.id === Number(id));
    if (!d) return { erreur: "Dépense introuvable.", statut: 404 };
    if (d.annulee) return { erreur: "Cette dépense est déjà annulée.", statut: 400 };
    d.annulee = true; d.annuleeLe = new Date().toISOString(); d.motifAnnulation = nettoyerTexte(p && p.motif, 300) || "Annulée";
    sauver();
    return { depense: d };
  }
  function listeDepenses() { return state.depenses.slice().sort((a, b) => b.id - a.id); }

  // ---- Journal normalise (Etape 56) ----
  // Un enregistrement par EVENEMENT, avec un identifiant unique et stable ("<marchand>:<numero de piece>") :
  // IzyCompta s'en sert pour ne jamais importer deux fois la meme ecriture (anti-doublon), meme si on
  // re-exporte plusieurs fois la meme periode. Les montants sont TTC en FCFA (XAF), positifs ; le sens
  // economique est porte par `type`.
  function journal(filtre) {
    const du = filtre && filtre.du ? filtre.du : null;
    const au = filtre && filtre.au ? filtre.au : null;
    const bascule = state.config.basculeLe || null;
    const sortie = [];
    function ajouter(e) {
      if (du && e.date < du) return;
      if (au && e.date > au) return;
      e.posterieurBascule = !!(bascule && e.creeLe > bascule);
      sortie.push(e);
    }
    for (const f0 of state.factures) {
      const f = vue(f0);
      const tiers = f.client.nom;
      ajouter({ id: merchantKey + ":" + f.numero, type: "vente", journal: "VE", date: f.date, creeLe: f.creeLe, piece: f.numero, refFacture: f.numero, tiers, telephoneTiers: f.client.telephone, libelle: "Facture " + f.numero + " — " + tiers, montant: f.total, moyen: null, categorie: null, origine: f.origine.type + (f.origine.id != null ? ":" + f.origine.id : "") });
      for (const p of f.paiements) {
        ajouter({ id: merchantKey + ":" + p.recuNumero, type: "encaissement", journal: "TR", date: dateLocale(p.date), creeLe: p.date, piece: p.recuNumero, refFacture: f.numero, tiers, telephoneTiers: f.client.telephone, libelle: "Encaissement " + p.recuNumero + " sur facture " + f.numero, montant: p.montant, moyen: p.methode, categorie: null, origine: "facture:" + f.numero });
      }
      for (const a of f.avoirs) {
        ajouter({ id: merchantKey + ":" + a.numero, type: "avoir_vente", journal: "VE", date: dateLocale(a.date), creeLe: a.date, piece: a.numero, refFacture: f.numero, tiers, telephoneTiers: f.client.telephone, libelle: "Avoir " + a.numero + " sur facture " + f.numero + " — " + a.motif, montant: a.montant, moyen: null, categorie: null, origine: "facture:" + f.numero });
      }
    }
    for (const d of state.depenses) {
      const tiers = d.fournisseur || "";
      ajouter({ id: merchantKey + ":" + d.numero, type: "depense", journal: "AC", date: d.date, creeLe: d.creeLe, piece: d.numero, refFacture: null, tiers, telephoneTiers: null, libelle: "Dépense " + d.numero + " — " + d.categorie + (d.note ? " — " + d.note : ""), montant: d.montant, moyen: d.methode, categorie: d.categorie, origine: "depense" });
      if (d.annulee) {
        ajouter({ id: merchantKey + ":" + d.numero + ":ANN", type: "depense_annulation", journal: "AC", date: dateLocale(d.annuleeLe), creeLe: d.annuleeLe, piece: d.numero, refFacture: null, tiers, telephoneTiers: null, libelle: "Annulation de la dépense " + d.numero + " — " + d.motifAnnulation, montant: d.montant, moyen: d.methode, categorie: d.categorie, origine: "depense" });
      }
    }
    sortie.sort((a, b) => (a.creeLe < b.creeLe ? -1 : a.creeLe > b.creeLe ? 1 : a.id < b.id ? -1 : 1));
    return sortie.map((e) => Object.assign({ source: SOURCE_JOURNAL, marchand: merchantKey, devise: "XAF" }, e));
  }

  const COLONNES_CSV = ["id", "source", "marchand", "type", "journal", "date", "piece", "refFacture", "tiers", "libelle", "montant", "devise", "moyen", "categorie", "origine", "posterieurBascule"];
  // `sep` : "," (defaut, format machine) ou ";" (Excel en francais ouvre un CSV a virgules sur UNE seule colonne).
  function journalCsv(filtre, sep) {
    const s0 = sep === ";" ? ";" : ",";
    const echapper = (v) => {
      const s = v == null ? "" : String(v);
      return /[";\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lignes = [COLONNES_CSV.join(s0)];
    for (const e of journal(filtre)) lignes.push(COLONNES_CSV.map((c) => echapper(e[c])).join(s0));
    return "﻿" + lignes.join("\r\n") + "\r\n";
  }

  // ---- Configuration / bascule ----
  function config() { return Object.assign({}, state.config); }
  function modifierConfig(patch) {
    Object.assign(state.config, patch);
    sauver();
    return config();
  }
  function aDesDonnees() { return state.factures.length > 0 || state.depenses.length > 0; }

  // Apercu avant bascule : derniers numeros emis par serie, factures dont le solde n'est pas nul.
  function apercuBascule() {
    const factures = listeFactures();
    const ouvertes = factures.filter((f) => f.statut !== "avoir" && f.solde > 0);
    const derniers = {};
    Object.keys(state.compteurs).forEach((k) => {
      const prefixe = k.split("-")[0];
      const num = k + "-" + String(state.compteurs[k]).padStart(4, "0");
      if (!derniers[prefixe] || num > derniers[prefixe]) derniers[prefixe] = num;
    });
    return {
      nbFactures: factures.length,
      nbDepenses: state.depenses.filter((d) => !d.annulee).length,
      derniersNumeros: derniers,
      facturesOuvertes: ouvertes.map((f) => ({ numero: f.numero, client: f.client.nom, solde: f.solde })),
      soldeOuvertTotal: ouvertes.reduce((s, f) => s + f.solde, 0)
    };
  }

  return {
    init, config, modifierConfig, aDesDonnees,
    creerFacture, enregistrerPaiement, creerAvoir, listeFactures, factureParId, factureParToken, factureParExternalRef,
    creerDepense, annulerDepense, listeDepenses,
    journal, journalCsv, apercuBascule,
    dateLocale
  };
}

module.exports = { creerMoteurFacturation, METHODES, CATEGORIES_DEPENSE, SOURCE_JOURNAL, dateLocale };
