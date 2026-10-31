"use strict";
// ============================================================================
// Etape 85 : reduction des couts Meta + notifications dans /admin.
//   1. Compteurs « a traiter » (pastilles des onglets de /admin), calcules a partir des moteurs deja charges - aucune donnee
//      supplementaire, aucune requete externe, donc interrogeables toutes les 15-20 s sans cout.
//   2. File de REGROUPEMENT des alertes WhatsApp commande / rendez-vous (option payante du super-administrateur) : la premiere
//      alerte part tout de suite, puis une pause pendant laquelle les nouveaux evenements sont mis en file et envoyes en UN
//      SEUL resume, seulement s'ils sont encore a traiter a la fin de la pause.
// Module sans dependance (aucun acces reseau ni disque) : tout ce qui touche WhatsApp lui est injecte, ce qui le rend testable.
// ============================================================================

// ---------------- Compteurs « a traiter » ----------------
// Definition (affichee en infobulle dans /admin) :
//   commandes     : commandes « Confirmée » (confirmees par le client, pas encore traitees) - hors Caisse, hors retrait en magasin
//                   quand le volet Enseigne est actif (ces dernieres vont dans « préparation »).
//   preparation   : commandes de retrait en magasin « Confirmée » dont la preparation n'a pas commence (etat « nouvelle »).
//   rendezvous    : rendez-vous « Confirmé » pas encore vus.            reservations : sejours « Confirmé » pas encore vus.
//   billets       : billets « Confirmé » pas encore vus.               conversations : clients en attente d'un humain.
// « Pas encore vu » = ni change de statut, ni marque vu (bouton « Tout marquer comme vu » -> marquerVus() du moteur).
function nonVu(x) { return x && x.source !== "simulateur" && x.statut === "Confirmé" && !x.vuLe; }

// Ensemble des references encore « a traiter » (sert a decider, a la fin d'une pause de regroupement, si un evenement mis en
// file merite toujours d'etre signale).
function refsATraiter(entry) {
  const refs = new Set();
  const m = (entry && entry.moteurs) || {};
  if (m.catalogue) {
    m.catalogue.getOrders().forEach((o) => {
      if (o.statut === "Confirmée" && o.source !== "pos") refs.add("CMD-" + String(o.id).padStart(4, "0"));
    });
  }
  if (m.service) m.service.getAppointments().forEach((a) => { if (nonVu(a)) refs.add("RDV-" + String(a.id).padStart(4, "0")); });
  if (m.hebergement) m.hebergement.getSejours().forEach((s) => { if (nonVu(s)) refs.add(s.reference || ("SEJ-" + String(s.id).padStart(4, "0"))); });
  if (m.transport) m.transport.getReservations({}).forEach((r) => { if (nonVu(r)) refs.add(r.reference); });
  return refs;
}

// ctx = { gestionnaire: bool (proprietaire ou super-administrateur), roles: [..] (employe), magasinImpose: id|null }
// Chaque compteur n'est renvoye (et calcule) que si l'utilisateur a le droit de voir l'onglet correspondant : un employe sans
// role « commandes » ne sait meme pas combien il y en a.
function calculerCompteurs(entry, ctx) {
  const c = ctx || {};
  const roles = c.roles || [];
  const a = (...r) => c.gestionnaire === true || r.some((x) => roles.indexOf(x) !== -1);
  const m = (entry && entry.moteurs) || {};
  const marchand = (entry && entry.merchant) || {};
  const out = {};
  if (m.catalogue && a("commandes")) {
    const ens = marchand.optionEnseigne === true;
    out.commandes = m.catalogue.getOrders().filter((o) => o.statut === "Confirmée" && o.source !== "pos" && !(ens && o.magasinId)).length;
  }
  if (m.catalogue && marchand.optionEnseigne === true && a("preparation")) {
    out.preparation = m.catalogue.getOrders().filter((o) =>
      o.statut === "Confirmée" && o.magasinId && (o.prepa || "nouvelle") === "nouvelle" && (!c.magasinImpose || o.magasinId === c.magasinImpose)).length;
  }
  if (m.service && a("rendezvous")) out.rendezvous = m.service.getAppointments().filter(nonVu).length;
  if (m.hebergement && a("rendezvous", "reservations", "hebergement")) out.reservations = m.hebergement.getSejours().filter(nonVu).length;
  if (m.transport && a("rendezvous", "reservations", "transport")) out.billets = m.transport.getReservations({}).filter(nonVu).length;
  if (a("conversations")) {
    let n = 0;
    Object.keys(m).forEach((t) => { try { n += m[t].getConversationsEnAttente().length; } catch (e) { /* moteur sans pause humain */ } });
    out.conversations = n;
  }
  out.total = Object.keys(out).reduce((s, k) => s + (out[k] || 0), 0);
  return out;
}

// « Tout marquer comme vu » pour un type d'element (rendezvous | reservations | billets). Renvoie le nombre marque.
function marquerVus(entry, genre) {
  const m = (entry && entry.moteurs) || {};
  const moteur = genre === "rendezvous" ? m.service : genre === "reservations" ? m.hebergement : genre === "billets" ? m.transport : null;
  return moteur && typeof moteur.marquerVus === "function" ? moteur.marquerVus() : 0;
}

// ---------------- Regroupement des alertes ----------------
// Nombre MAXIMUM d'alertes (individuelles ou resumees) par jour et par numero pour un intervalle donne.
function alertesMaxParJour(intervalleMinutes) {
  return intervalleMinutes > 0 ? Math.floor(1440 / intervalleMinutes) : null;
}

function libelleResume(evenements) {
  const n = { commande: 0, rdv: 0, modif: 0 };
  evenements.forEach((e) => { if (e.type === "commande_confirmee") n.commande++; else if (e.type === "rdv_confirme") n.rdv++; else n.modif++; });
  const parts = [];
  if (n.commande) parts.push(n.commande + (n.commande > 1 ? " commandes" : " commande"));
  if (n.rdv) parts.push(n.rdv + (n.rdv > 1 ? " rendez-vous ou réservations" : " rendez-vous ou réservation"));
  if (n.modif) parts.push(n.modif + (n.modif > 1 ? " modifications ou annulations" : " modification ou annulation"));
  return parts.join(", ");
}

// deps = {
//   intervalleMs(): intervalle effectif en ms (0 = pas de regroupement),
//   estEncoreATraiter(evenement): booleen,
//   envoyerEvenement(evenement): Promise  (alerte individuelle, comme avant),
//   envoyerResume(evenements): Promise    (UN message pour plusieurs evenements),
//   maintenant(): ms (defaut Date.now), planifier(fn, ms): handle (defaut setTimeout), annuler(handle)
// }
// Un evenement : { type, params, destinataires, cle }  (cle = reference, ex. « CMD-0004 »).
function creerFileAlertes(deps) {
  const maintenant = deps.maintenant || (() => Date.now());
  const planifier = deps.planifier || ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; });
  const annuler = deps.annuler || ((h) => clearTimeout(h));
  let dernierEnvoi = null;
  let minuteur = null;
  let file = [];

  async function vider() {
    minuteur = null;
    const lot = file; file = [];
    const restants = [];
    for (const e of lot) {
      let encore = true;
      try { encore = deps.estEncoreATraiter(e) !== false; } catch (err) { encore = true; }
      if (encore) restants.push(e);
    }
    if (!restants.length) return { envoyes: 0 };
    dernierEnvoi = maintenant();
    if (restants.length === 1) { await deps.envoyerEvenement(restants[0]); return { envoyes: 1, resume: false }; }
    await deps.envoyerResume(restants);
    return { envoyes: restants.length, resume: true };
  }

  async function soumettre(evenement) {
    const intervalle = deps.intervalleMs();
    if (!intervalle || intervalle <= 0) return deps.envoyerEvenement(evenement);
    const now = maintenant();
    if (!minuteur && (dernierEnvoi === null || now - dernierEnvoi >= intervalle)) {
      dernierEnvoi = now;
      return deps.envoyerEvenement(evenement);
    }
    file.push(evenement);
    if (!minuteur) {
      const attente = Math.max(1000, (dernierEnvoi === null ? now : dernierEnvoi) + intervalle - now);
      minuteur = planifier(() => { vider().catch((e) => console.error("Echec du resume d'alertes regroupees :", e)); }, attente);
    }
    return null;
  }

  return {
    soumettre,
    vider,
    etat: () => ({ enFile: file.length, minuteurActif: !!minuteur, dernierEnvoi }),
    arreter: () => { if (minuteur) { annuler(minuteur); minuteur = null; } }
  };
}

// ---------------- Rappels de rendez-vous au client : quels canaux essayer, dans l'ordre ----------------
// Fenetre de 24 h ouverte : texte libre (gratuit) ; en cas de refus, modele facture SEULEMENT si l'option « rappels » est ouverte.
// Fenetre fermee : modele facture seulement si l'option est ouverte ; sinon liste vide = rappel REPORTE (rien envoye, aucun essai compte).
function canauxRappel(fenetreOuverte, rappelsActifs) {
  const c = [];
  if (fenetreOuverte) c.push("texte");
  if (rappelsActifs) c.push("modele");
  return c;
}

module.exports = { canauxRappel, refsATraiter, calculerCompteurs, marquerVus, alertesMaxParJour, libelleResume, creerFileAlertes };
