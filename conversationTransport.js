// IzyVendeur - Moteur de conversation « transport » (Etape 74) : billets de train, de car, de navette... par WhatsApp.
//
// Un marchand « transport » (Camrail, une compagnie de cars, une navette d'aeroport) vend des PLACES sur des DEPARTS
// d'une LIGNE qui dessert plusieurs ARRETS. Le client choisit son trajet, son arret de descente (et, s'il le souhaite,
// son arret de montee), le jour, le depart, la classe et le cote (fenetre / couloir), le nombre de voyageurs puis donne
// le nom et le numero de CNI de chacun (manifeste). Il obtient une reservation « A payer » dont les places sont retenues
// pendant un delai ; l'equipe la passe a « Confirme » une fois le paiement recu.
//
// Modele de disponibilite (comme un avion) : le client ne choisit PAS le siege exact. Le marchand reserve au canal WhatsApp
// un QUOTA de places par depart, par classe et par cote (fenetre / couloir) - ou un total pour les classes sans cote (navette).
// La disponibilite se calcule TRONCON par TRONCON : un voyageur Douala -> Eseka occupe les troncons Douala-Edea et Edea-Eseka ;
// la place se libere donc pour Eseka -> Yaounde. L'attribution du siege exact viendra plus tard (le quota la prepare).
//
// Parcours : toutes les saisies sont des LISTES deroulantes (server.js les construit a partir de getEtatSession().liste),
// avec « ◀ Retour » a chaque etape ; seules les confirmations sont des boutons. Le client peut aussi taper le libelle d'une
// ligne. La prochaine question est toujours DEDUITE de ce qui est deja renseigne (prochaineEtape), ce qui rend « Retour » et
// « Modifier » triviaux : on efface des champs, la bonne question revient.
//
// Vie privee : le numero de CNI est chiffre (AES-256-GCM, crypto-util.js) des sa reception - y compris dans la session
// sauvegardee -, masque (****1234) dans les recapitulatifs, le journal des conversations et l'admin ; il n'est dechiffre que
// pour le manifeste d'un depart (route reservee a l'equipe habilitee, journalisee).
//
// Exporte une factory comme les autres moteurs : createTransportEngine(merchantKey, options).

const db = require("./db");
const sessionsPersistantes = require("./sessionsPersistantes");
const sh = require("./shared");
const dt = require("./datesSejour");
const cryptoUtil = require("./crypto-util");
const { formatFcfa } = sh;

const PHONE_SIMULATEUR = "SIMULATEUR";
const PREFIXE = "IZY_TR_";
const STATUTS_VALIDES = ["À payer", "Confirmé", "Embarqué", "Absent", "Annulé", "Expiré"];
const STATUTS_BLOQUANTS = ["À payer", "Confirmé", "Embarqué"]; // « À payer » seulement tant que la retenue n'a pas expire
const MAX_A_PAYER_PAR_TELEPHONE = 3;
const LIGNES_MAX = 7; // lignes de contenu par liste (10 - Retour - Menu principal - Conseiller)

const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const JOURS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const RE_BILLETS = /\b(mes billets?|mon billet|my tickets?|mes reservations?|ma reservation|my bookings?|my booking)\b/;
const RE_RETOUR = /^(retour|back|precedent|previous|revenir)$/;
const RE_RECOMMENCER = /^(annuler|cancel|recommencer|restart|abandonner|stop)$/;

function norm(t) { return dt.normaliser(t); }
function tronquer(t, max) { t = String(t == null ? "" : t); return t.length > max ? t.slice(0, Math.max(0, max - 1)) + "…" : t; }
function entierPositif(v, defaut) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : defaut; }
function heureValide(h) { return typeof h === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(h.trim()); }
function heureNorm(h) { const p = String(h).trim().split(":"); return (p[0].length < 2 ? "0" + p[0] : p[0]) + ":" + p[1]; }
function heureLisible(h) { return h ? String(h).replace(":", "h") : ""; }
function idPropre(v, repli) { const s = String(v == null ? "" : v).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24); return s || repli; }
function dateIsoValide(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }

function reglagesParDefaut() {
  return {
    delaiRetenueMinutes: 120,        // temps laisse au client pour payer avant que les places soient rendues
    clotureAvantDepartMinutes: 30,   // plus de vente WhatsApp dans les N minutes avant le depart
    avanceMaxJours: 30,              // horizon des dates proposees
    maxVoyageurs: 4,                 // voyageurs par reservation
    choixMontee: true,               // proposer l'arret de montee quand le trajet a des arrets intermediaires
    notePaiement: "Réglez par Orange Money ou MTN MoMo en indiquant votre référence ; notre équipe confirme votre billet dès réception.",
    notePaiementEn: "Pay by Orange Money or MTN MoMo quoting your reference; our team confirms your ticket as soon as it is received.",
    consigne: "Présentez-vous 45 minutes avant le départ avec votre pièce d'identité.",
    consigneEn: "Please arrive 45 minutes before departure with your ID.",
    autoConfirmMessage: "Merci pour votre réservation, bon voyage !",
    autoConfirmMessageEn: "",
    fuseau: sh.FUSEAU_PAR_DEFAUT
  };
}

function seedStateVide() {
  return { lignes: [], departs: [], reservations: [], nextId: 1, settings: reglagesParDefaut() };
}
const seedState = seedStateVide; // aucun jeu de donnees imposé : « Charger l'exemple » (admin) remplit une demonstration

// ---------------- Donnees de demonstration (Camrail + navette d'aeroport) ----------------
// Horaires et tarifs de la ligne Douala - Yaounde d'apres la plaquette publique ; arrets intermediaires, distances et navette :
// valeurs D'EXEMPLE a ajuster par le marchand.
function donneesExemple() {
  const tousJours = [0, 1, 2, 3, 4, 5, 6];
  const train = {
    id: "l1", nom: "Douala – Yaoundé", mode: "train", actif: true,
    arrets: [
      { id: "dla", nom: "Douala", pk: 0 }, { id: "eda", nom: "Édéa", pk: 66 },
      { id: "ese", nom: "Eséka", pk: 150 }, { id: "yde", nom: "Yaoundé", pk: 263 }
    ],
    classes: [
      { id: "prem", nom: "Premium", cote: true, description: "" },
      { id: "pcl", nom: "Première classe", cote: true, description: "" }
    ],
    tarifs: []
  };
  train.tarifs = calculerTarifs(train, { prem: { prix: 6000, prixAR: 11000 }, pcl: { prix: 9000, prixAR: 15000 } });
  const navette = {
    id: "l2", nom: "Navette aéroport", mode: "navette", actif: true,
    arrets: [
      { id: "apt", nom: "Aéroport de Douala", pk: 0 }, { id: "akw", nom: "Akwa", pk: 7 }, { id: "bmo", nom: "Bonamoussadi", pk: 14 }
    ],
    classes: [{ id: "std", nom: "Standard", cote: false, description: "" }],
    tarifs: []
  };
  navette.tarifs = calculerTarifs(navette, { std: { prix: 5000, prixAR: 9000 } });
  const departs = [
    { id: "d1", ligneId: "l1", sens: 1, heure: "06:30", passages: { dla: "06:30", eda: "07:30", ese: "09:15", yde: "11:15" }, jours: tousJours, fermes: [], actif: true,
      quotas: { prem: { fenetre: 20, couloir: 20 }, pcl: { fenetre: 10, couloir: 10 } } },
    { id: "d2", ligneId: "l1", sens: -1, heure: "17:00", passages: { yde: "17:00", ese: "19:10", eda: "20:40", dla: "21:45" }, jours: tousJours, fermes: [], actif: true,
      quotas: { prem: { fenetre: 20, couloir: 20 }, pcl: { fenetre: 10, couloir: 10 } } }
  ];
  [["d3", 1, "08:00"], ["d4", 1, "12:00"], ["d5", 1, "16:00"], ["d6", 1, "20:00"], ["d7", -1, "06:00"], ["d8", -1, "10:00"], ["d9", -1, "14:00"], ["d10", -1, "18:00"]].forEach((x) => {
    departs.push({ id: x[0], ligneId: "l2", sens: x[1], heure: x[2], passages: {}, jours: tousJours, fermes: [], actif: true, quotas: { std: { total: 14 } } });
  });
  return { lignes: [train, navette], departs };
}

// Tarifs d'une ligne a partir du prix de bout en bout de chaque classe : proportionnel a la distance (pk) entre arrets,
// arrondi a 500 FCFA. `base` : { classeId: { prix, prixAR } }.
function calculerTarifs(ligne, base) {
  const arrets = ligne.arrets;
  const total = Math.max(1, (Number(arrets[arrets.length - 1].pk) || 0) - (Number(arrets[0].pk) || 0));
  const arrondi = (v) => Math.max(500, Math.round(v / 500) * 500);
  const out = [];
  for (let i = 0; i < arrets.length; i++) {
    for (let j = i + 1; j < arrets.length; j++) {
      const part = ((Number(arrets[j].pk) || 0) - (Number(arrets[i].pk) || 0)) / total;
      Object.keys(base || {}).forEach((cid) => {
        const b = base[cid] || {};
        const pleine = i === 0 && j === arrets.length - 1;
        const prix = pleine ? Number(b.prix) || 0 : arrondi((Number(b.prix) || 0) * part);
        const prixAR = b.prixAR ? (pleine ? Number(b.prixAR) : arrondi(Number(b.prixAR) * part)) : 0;
        out.push({ de: arrets[i].id, vers: arrets[j].id, classeId: cid, prix, prixAR });
      });
    }
  }
  return out;
}

function createTransportEngine(merchantKey, options) {
  let state = null;
  const sessions = {};
  const conversationsHumain = {};
  const humanHintDonne = {};
  const envoyer = (options && options.envoyer) || (async () => {});
  const notifierMarchand = (options && options.notifierMarchand) || (async () => {});
  const nomMarchandOption = (options && options.nomMarchand) || (() => "");
  const journaliserOption = (options && options.journaliser) || (async () => {});
  const cleEtat = (options && options.cleEtat) || merchantKey;

  const persistance = sessionsPersistantes.creer({
    cle: cleEtat, sessions, conversationsHumain, ignorer: [PHONE_SIMULATEUR],
    regle: (s, age) => {
      const J = sessionsPersistantes.JOUR_MS;
      if (age > sessionsPersistantes.DUREE_MAX_JOURS * J) return null;
      if (age <= J) return s;
      const neuve = freshSession(s); neuve.fromPhone = s.fromPhone;
      return neuve;
    }
  });

  function journaliser(telephone, de, texte) {
    if (!telephone || telephone === PHONE_SIMULATEUR) return;
    journaliserOption(telephone, de, texte).catch((erreur) => console.error("[" + merchantKey + "] Echec de journalisation de la conversation :", erreur));
  }

  async function init() {
    state = await db.initMerchantState(cleEtat, options && options.sansDonneesDemo ? seedStateVide : seedState);
    if (!Array.isArray(state.lignes)) state.lignes = [];
    if (!Array.isArray(state.departs)) state.departs = [];
    if (!Array.isArray(state.reservations)) state.reservations = [];
    if (!state.nextId) state.nextId = 1;
    state.settings = Object.assign(reglagesParDefaut(), state.settings || {});
    if (!sh.fuseauValide(state.settings.fuseau)) state.settings.fuseau = sh.FUSEAU_PAR_DEFAUT;
    await persistance.charger();
  }
  function saveState() {
    if (!state) return;
    db.persistMerchantState(cleEtat, state).catch((erreur) => console.error("[" + merchantKey + "] Erreur de sauvegarde de l'etat :", erreur));
  }

  function fz() { return (state && state.settings && sh.fuseauValide(state.settings.fuseau) && state.settings.fuseau) || sh.FUSEAU_PAR_DEFAUT; }
  function reg() { return (state && state.settings) || reglagesParDefaut(); }

  // ---------------- Dates ----------------
  function aujourdhuiISO(maintenant) { const p = sh.partiesFuseau(maintenant || new Date(), fz()); return dt.iso(p.annee, p.mois, p.jour); }
  function formatJour(dateIso, session) {
    const en = sh.langueSession(session) === "en";
    const p = dateIso.split("-").map(Number);
    const i = dt.jourSemaineDe(dateIso);
    return en ? JOURS_EN[i] + " " + p[2] + " " + MOIS_EN[p[1] - 1] : JOURS_FR[i] + " " + (p[2] === 1 ? "1er" : p[2]) + " " + MOIS_FR[p[1] - 1];
  }
  function formatCourt(dateIso, session) {
    const en = sh.langueSession(session) === "en";
    const p = dateIso.split("-").map(Number);
    const i = dt.jourSemaineDe(dateIso);
    return en ? JOURS_EN[i].slice(0, 3) + " " + p[2] + " " + MOIS_EN[p[1] - 1].slice(0, 3) : JOURS_FR[i].slice(0, 3) + " " + p[2] + " " + MOIS_FR[p[1] - 1].slice(0, 4) + (MOIS_FR[p[1] - 1].length > 4 ? "." : "");
  }
  function instant(dateIso, hhmm) {
    const p = dateIso.split("-").map(Number); const h = String(hhmm || "00:00").split(":").map(Number);
    return sh.dateDepuisPartiesFuseau(p[0], p[1], p[2], h[0] || 0, h[1] || 0, fz());
  }

  // ---------------- Lignes, departs, tarifs ----------------
  function ligneParId(id) { return state.lignes.filter((l) => l.id === id)[0] || null; }
  function departParId(id) { return state.departs.filter((d) => d.id === id)[0] || null; }
  function lignesActives() { return state.lignes.filter((l) => l.actif !== false && l.arrets.length >= 2 && l.classes.length); }
  function ordreArrets(ligne, sens) { return sens === -1 ? ligne.arrets.slice().reverse() : ligne.arrets.slice(); }
  function indexDans(ordre, arretId) { for (let i = 0; i < ordre.length; i++) if (ordre[i].id === arretId) return i; return -1; }
  function arretNom(ligne, arretId) { const a = ligne.arrets.filter((x) => x.id === arretId)[0]; return a ? a.nom : String(arretId); }
  function departsActifs(ligneId, sens) { return state.departs.filter((d) => d.actif !== false && d.ligneId === ligneId && d.sens === sens).sort((a, b) => a.heure < b.heure ? -1 : a.heure > b.heure ? 1 : 0); }
  function circule(depart, dateIso) {
    if (depart.actif === false) return false;
    if (Array.isArray(depart.jours) && depart.jours.length && depart.jours.indexOf(dt.jourSemaineDe(dateIso)) === -1) return false;
    if ((depart.fermes || []).indexOf(dateIso) !== -1) return false;
    if (depart.debut && dateIso < depart.debut) return false;
    if (depart.fin && dateIso > depart.fin) return false;
    return true;
  }
  function heurePassage(depart, ligne, arretId) {
    const p = depart.passages && depart.passages[arretId];
    if (p && heureValide(p)) return heureNorm(p);
    const ordre = ordreArrets(ligne, depart.sens);
    return ordre.length && ordre[0].id === arretId ? heureNorm(depart.heure) : null;
  }
  function achetable(depart, ligne, dateIso, deId, maintenant) {
    const h = heurePassage(depart, ligne, deId) || heureNorm(depart.heure);
    return instant(dateIso, h).getTime() - entierPositif(reg().clotureAvantDepartMinutes, 30) * 60000 > (maintenant || new Date()).getTime();
  }
  // Tarif d'une paire d'arrets (dans un sens ou dans l'autre) pour une classe : { prix, prixAR } ou null.
  function tarifPaire(ligne, deId, versId, classeId) {
    const i = ligne.arrets.findIndex((a) => a.id === deId), j = ligne.arrets.findIndex((a) => a.id === versId);
    if (i < 0 || j < 0 || i === j) return null;
    const a = i < j ? deId : versId, b = i < j ? versId : deId;
    const t = (ligne.tarifs || []).filter((x) => x.de === a && x.vers === b && x.classeId === classeId)[0];
    return t && Number(t.prix) > 0 ? { prix: Number(t.prix), prixAR: Number(t.prixAR) > 0 ? Number(t.prixAR) : 0 } : null;
  }
  function prixMinPaire(ligne, deId, versId) {
    let m = null;
    ligne.classes.forEach((c) => { const t = tarifPaire(ligne, deId, versId, c.id); if (t && (m == null || t.prix < m)) m = t.prix; });
    return m;
  }
  function classeParId(ligne, id) { return ligne.classes.filter((c) => c.id === id)[0] || null; }

  // ---------------- Disponibilite par troncon ----------------
  function expirerReservations(maintenant) {
    const now = (maintenant || new Date()).getTime();
    let change = false;
    state.reservations.forEach((r) => {
      if (r.statut === "À payer" && r.expireLe && new Date(r.expireLe).getTime() <= now) {
        r.statut = "Expiré"; r.historique = (r.historique || []).concat([{ le: new Date(now).toISOString(), statut: "Expiré", par: "système", raison: "Délai de paiement dépassé" }]);
        change = true;
      }
    });
    if (change) saveState();
  }
  function actives(ignorerId) { return state.reservations.filter((r) => STATUTS_BLOQUANTS.indexOf(r.statut) !== -1 && r.id !== ignorerId); }
  function quotasDe(depart, dateIso) { return (depart.quotasParDate && depart.quotasParDate[dateIso]) || depart.quotas || {}; }
  function quota(depart, dateIso, classeId, cote) {
    const q = quotasDe(depart, dateIso)[classeId];
    return q ? entierPositif(q[cote], 0) : 0;
  }
  function jambes(r) { return [r.aller, r.retour].filter(Boolean); }
  // Places deja prises sur le troncon `seg` (index dans l'ordre du depart) pour (depart, date, classe, cote).
  function occupe(depart, ligne, dateIso, classeId, cote, seg, actifs) {
    const ordre = ordreArrets(ligne, depart.sens);
    let n = 0;
    actifs.forEach((r) => jambes(r).forEach((leg) => {
      if (leg.departId !== depart.id || leg.date !== dateIso || leg.classeId !== classeId) return;
      const a = indexDans(ordre, leg.de), b = indexDans(ordre, leg.vers);
      if (a < 0 || b <= a || seg < a || seg >= b) return;
      n += (leg.cotes && leg.cotes[cote]) || 0;
    }));
    return n;
  }
  function dispoSimple(depart, ligne, dateIso, deId, versId, classeId, cote, actifs) {
    const ordre = ordreArrets(ligne, depart.sens);
    const a = indexDans(ordre, deId), b = indexDans(ordre, versId);
    if (a < 0 || b <= a) return 0;
    const q = quota(depart, dateIso, classeId, cote);
    let min = q;
    for (let seg = a; seg < b; seg++) min = Math.min(min, q - occupe(depart, ligne, dateIso, classeId, cote, seg, actifs));
    return Math.max(0, min);
  }
  function coteClasse(ligne, classeId) { const c = classeParId(ligne, classeId); return c && c.cote ? ["fenetre", "couloir"] : ["total"]; }
  // `cote` : "fenetre" | "couloir" | "total" | "indiff" (peu importe). Retourne le nombre de places libres sur tout le trajet.
  function dispo(depart, ligne, dateIso, deId, versId, classeId, cote, ignorerId) {
    const actifs = actives(ignorerId);
    if (cote === "indiff") return dispoSimple(depart, ligne, dateIso, deId, versId, classeId, "fenetre", actifs) + dispoSimple(depart, ligne, dateIso, deId, versId, classeId, "couloir", actifs);
    return dispoSimple(depart, ligne, dateIso, deId, versId, classeId, cote, actifs);
  }
  function dispoClasse(depart, ligne, dateIso, deId, versId, classeId) {
    return coteClasse(ligne, classeId).reduce((s, c) => s + dispo(depart, ligne, dateIso, deId, versId, classeId, c), 0);
  }
  // Repartition des `nb` places entre les cotes : { fenetre, couloir } ou { total } - null si impossible.
  function allouer(depart, ligne, dateIso, deId, versId, classeId, coteDemande, nb, ignorerId) {
    const actifs = actives(ignorerId);
    const d = (c) => dispoSimple(depart, ligne, dateIso, deId, versId, classeId, c, actifs);
    if (coteDemande === "total") return d("total") >= nb ? { total: nb } : null;
    if (coteDemande === "fenetre" || coteDemande === "couloir") return d(coteDemande) >= nb ? { [coteDemande]: nb } : null;
    const f = d("fenetre"), c = d("couloir");
    if (f + c < nb) return null;
    const premier = f >= c ? "fenetre" : "couloir", second = premier === "fenetre" ? "couloir" : "fenetre";
    const dp = premier === "fenetre" ? f : c;
    const r = {};
    r[premier] = Math.min(nb, dp);
    if (nb - r[premier] > 0) r[second] = nb - r[premier];
    return r;
  }
  function placesLibresMax(depart, ligne, dateIso, deId, versId, classeId, coteDemande) {
    if (coteDemande === "indiff") return dispo(depart, ligne, dateIso, deId, versId, classeId, "indiff");
    return dispo(depart, ligne, dateIso, deId, versId, classeId, coteDemande);
  }

  // ---------------- Sessions ----------------
  function freshSession(precedente) {
    return { langue: precedente ? precedente.langue : null, d: {}, auto: {}, vue: null, billetId: null, page: 0, nomEnCours: null, accueilFait: false, sansListe: false };
  }
  function getSession(fromPhone) {
    if (!sessions[fromPhone]) sessions[fromPhone] = freshSession();
    const s = sessions[fromPhone];
    if (!s.d) s.d = {}; if (!s.auto) s.auto = {};
    s.fromPhone = fromPhone;
    return s;
  }
  function T(s, fr, en) { return sh.t(s, fr, en); }
  function voyageursDe(s) { if (!Array.isArray(s.d.voyageurs)) s.d.voyageurs = []; return s.d.voyageurs; }

  const ORDRE = ["trajet", "descente", "montee", "date", "depart", "classe", "cote", "formule", "dateRetour", "departRetour", "nb"];
  function prochaineEtape(s) {
    if (s.vue) return s.vue;
    const d = s.d;
    if (!d.trajet) return "idle";
    if (!d.descente) return "descente";
    if (!d.montee) return "montee";
    if (!d.date) return "date";
    if (!d.depart) return "depart";
    if (!d.classe) return "classe";
    if (!d.cote) return "cote";
    if (!d.formule) return "formule";
    if (d.formule === "ar") { if (!d.dateRetour) return "date_retour"; if (!d.departRetour) return "depart_retour"; }
    if (!d.nb) return "nb";
    const v = voyageursDe(s);
    if (s.nomEnCours != null) return "cni";
    if (v.length < d.nb) return "nom";
    return "recap";
  }
  function effacerChamp(s, k) { delete s.d[k]; delete s.auto[k]; if (k === "nb") { s.d.voyageurs = []; s.nomEnCours = null; } }
  function retourParcours(s) {
    s.page = 0;
    if (s.nomEnCours != null) { s.nomEnCours = null; return; }
    const v = voyageursDe(s);
    if (s.d.nb && v.length > 0 && v.length < s.d.nb) { const dernier = v.pop(); s.nomEnCours = dernier.nom; return; }
    if (s.d.nb && v.length >= s.d.nb) { const dernier = v.pop(); s.nomEnCours = dernier.nom; return; } // depuis le recapitulatif : on rouvre le dernier CNI
    for (let i = ORDRE.length - 1; i >= 0; i--) {
      const k = ORDRE[i];
      if (s.d[k] != null) { const etaitAuto = !!s.auto[k]; effacerChamp(s, k); if (!etaitAuto) break; }
    }
  }
  function retourVue(s) {
    s.page = 0;
    if (s.vue === "annul") s.vue = "billet";
    else if (s.vue === "billet") { s.vue = billetsDuClient(s.fromPhone).length > 1 ? "billets" : null; s.billetId = null; }
    else s.vue = null;
  }

  // ---------------- Dates proposees ----------------
  function departsPossibles(ctx, dateIso, apresHeure) {
    const ligne = ligneParId(ctx.ligneId);
    if (!ligne) return [];
    const out = [];
    departsActifs(ligne.id, ctx.sens).forEach((dep) => {
      if (!circule(dep, dateIso) || !achetable(dep, ligne, dateIso, ctx.de)) return;
      if (apresHeure) { const h = heurePassage(dep, ligne, ctx.de) || heureNorm(dep.heure); if (h <= apresHeure) return; }
      const classes = ligne.classes.filter((c) => tarifPaire(ligne, ctx.de, ctx.vers, c.id) && dispoClasse(dep, ligne, dateIso, ctx.de, ctx.vers, c.id) > 0 &&
        (!ctx.classeId || (c.id === ctx.classeId && (!ctx.cote || dispo(dep, ligne, dateIso, ctx.de, ctx.vers, c.id, ctx.cote) > 0))));
      if (classes.length) out.push({ depart: dep, classes });
    });
    return out;
  }
  function joursPossibles(ctx, depuisIso, apresHeureLeJour) {
    const horizon = Math.min(entierPositif(reg().avanceMaxJours, 30) || 30, 90);
    const debut = depuisIso || aujourdhuiISO();
    const out = [];
    for (let i = 0; i < horizon; i++) {
      const jour = dt.ajouterJours(debut, i);
      const n = departsPossibles(ctx, jour, jour === depuisIso ? apresHeureLeJour : null).length;
      if (n) out.push({ date: jour, n, delta: dt.nuitsEntre(aujourdhuiISO(), jour) });
    }
    return out;
  }
  function ctxAller(s) {
    const t = parseTrajet(s.d.trajet);
    return t ? { ligneId: t.ligneId, sens: t.sens, de: s.d.montee, vers: s.d.descente } : null;
  }
  function ctxRetour(s) {
    const t = parseTrajet(s.d.trajet);
    return t ? { ligneId: t.ligneId, sens: -t.sens, de: s.d.descente, vers: s.d.montee, classeId: s.d.classe, cote: s.d.cote } : null;
  }
  function parseTrajet(v) {
    const m = String(v || "").match(/^([A-Za-z0-9_-]+):(1|-1)$/);
    return m ? { ligneId: m[1], sens: Number(m[2]) } : null;
  }
  function trajetsListe() {
    const out = [];
    lignesActives().forEach((l) => {
      [1, -1].forEach((sens) => {
        const deps = departsActifs(l.id, sens);
        if (!deps.length) return;
        const ordre = ordreArrets(l, sens);
        out.push({ ligne: l, sens, ordre, departs: deps, id: l.id + ":" + sens });
      });
    });
    return out;
  }

  // ---------------- Calculs de prix et de lecture ----------------
  function prixUnitaire(s) {
    const t = parseTrajet(s.d.trajet); const ligne = t && ligneParId(t.ligneId);
    if (!ligne) return 0;
    const tp = tarifPaire(ligne, s.d.montee, s.d.descente, s.d.classe);
    if (!tp) return 0;
    return s.d.formule === "ar" ? (tp.prixAR || tp.prix * 2) : tp.prix;
  }
  function resumeJambe(ligne, depart, dateIso, deId, versId, classeId, cote, session) {
    const hDe = heurePassage(depart, ligne, deId), hVers = heurePassage(depart, ligne, versId);
    return {
      date: dateIso, jour: formatJour(dateIso, session), de: arretNom(ligne, deId), vers: arretNom(ligne, versId),
      heureDe: hDe, heureVers: hVers
    };
  }
  function libelleCote(cote, session) {
    if (cote === "fenetre") return T(session, "Fenêtre", "Window");
    if (cote === "couloir") return T(session, "Couloir", "Aisle");
    if (cote === "indiff") return T(session, "Fenêtre ou couloir", "Window or aisle");
    return "";
  }
  function libelleJambeTexte(ligne, depart, dateIso, deId, versId, session) {
    const j = resumeJambe(ligne, depart, dateIso, deId, versId, null, null, session);
    return j.jour + " — " + T(session, "départ ", "departs ") + (j.heureDe ? heureLisible(j.heureDe) : heureLisible(depart.heure)) + T(session, " de ", " from ") + j.de +
      (j.heureVers ? T(session, ", arrivée ", ", arrives ") + heureLisible(j.heureVers) + T(session, " à ", " at ") : T(session, " → ", " → ")) + j.vers;
  }
  function cniMasque(cniClair) { const c = String(cniClair || ""); return "****" + c.slice(-4); }
  function ref(r) { return "TRP-" + String(r.id).padStart(4, "0"); }

  function recapTexte(s) {
    const d = s.d; const t = parseTrajet(d.trajet); const ligne = ligneParId(t.ligneId);
    const dep = departParId(d.depart);
    const classe = classeParId(ligne, d.classe);
    const lignes = [T(s, "Récapitulatif de votre réservation :", "Your booking summary:")];
    lignes.push(T(s, "Aller : ", "Outbound: ") + libelleJambeTexte(ligne, dep, d.date, d.montee, d.descente, s));
    if (d.formule === "ar") {
      const depR = departParId(d.departRetour);
      lignes.push(T(s, "Retour : ", "Return: ") + libelleJambeTexte(ligne, depR, d.dateRetour, d.descente, d.montee, s));
    }
    lignes.push(T(s, "Classe : ", "Class: ") + classe.nom + (d.cote && d.cote !== "total" ? " — " + libelleCote(d.cote, s) : ""));
    lignes.push(T(s, "Voyageurs :", "Passengers:"));
    voyageursDe(s).forEach((v, i) => lignes.push((i + 1) + ". " + v.nom + " — CNI " + v.cniMasque));
    const unit = prixUnitaire(s);
    lignes.push(T(s, "Total : ", "Total: ") + formatFcfa(unit * d.nb) + " (" + (d.formule === "ar" ? T(s, "aller-retour", "return") : T(s, "aller simple", "one way")) + (d.nb > 1 ? ", " + d.nb + " × " + formatFcfa(unit) : "") + ")");
    return lignes.join("\n");
  }

  // ---------------- Presentation : question + liste/boutons de l'etape courante ----------------
  function paginer(tout, s) {
    if (tout.length <= LIGNES_MAX) return tout;
    const parPage = LIGNES_MAX - 1;
    const page = Math.max(0, Math.min(s.page || 0, Math.ceil(tout.length / parPage) - 1));
    const part = tout.slice(page * parPage, page * parPage + parPage);
    if ((page + 1) * parPage < tout.length) part.push({ id: PREFIXE + "PLUS:" + (page + 1), title: T(s, "Voir plus ▸", "See more ▸"), description: "" });
    return part;
  }
  function liste(s, bouton, section, tout, retour) {
    return { bouton, section, lignes: paginer(tout, s), tout, retour: retour !== false };
  }
  function ligneRow(id, title, description) { return { id, title: tronquer(title, 24), description: tronquer(description || "", 72) }; }
  function entete(s) {
    const d = s.d; const t = parseTrajet(d.trajet); const ligne = t && ligneParId(t.ligneId);
    if (!ligne) return "";
    const ordre = ordreArrets(ligne, t.sens);
    return ordre[0].nom + " → " + ordre[ordre.length - 1].nom;
  }
  function presenterEtape(s) {
    const etape = prochaineEtape(s);
    const d = s.d;
    const t = parseTrajet(d.trajet); const ligne = t && ligneParId(t.ligneId);
    if (!(etape === "idle" || s.vue) && !ligne) { s.d = {}; s.auto = {}; return presenterEtape(s); }
    switch (etape) {
      case "idle": {
        const trajets = trajetsListe();
        const rows = [];
        const nb = billetsDuClient(s.fromPhone).length;
        if (nb) rows.push(ligneRow(PREFIXE + "MB", T(s, "Mes billets (" + nb + ")", "My tickets (" + nb + ")"), T(s, "Voir ou annuler", "View or cancel")));
        trajets.forEach((x) => {
          const prix = prixMinPaire(x.ligne, x.ordre[0].id, x.ordre[x.ordre.length - 1].id);
          const heures = x.departs.slice(0, 3).map((dep) => heureLisible(heureNorm(dep.heure))).join(" · ");
          rows.push(ligneRow(PREFIXE + "T:" + x.id, x.ordre[0].nom + " → " + x.ordre[x.ordre.length - 1].nom, (prix ? T(s, "Dès ", "From ") + formatFcfa(prix) + " · " : "") + heures));
        });
        const nom = nomMarchandOption();
        const corps = s.accueilFait
          ? T(s, "Pour quel trajet souhaitez-vous voyager ?", "Which route would you like to travel?")
          : (T(s, "Bonjour ! Bienvenue" + (nom ? " chez " + nom : "") + ".\nPour quel trajet souhaitez-vous voyager ?", "Hello! Welcome" + (nom ? " to " + nom : "") + ".\nWhich route would you like to travel?"));
        if (!trajets.length) return { texte: T(s, "Aucun départ n'est ouvert à la réservation en ce moment. Un conseiller peut vous renseigner.", "No departure is open for booking right now. An advisor can help you."), liste: null, boutons: null };
        return { texte: corps, liste: liste(s, T(s, "Choisir le trajet", "Choose route"), T(s, "Nos trajets", "Our routes"), rows, false) };
      }
      case "descente": {
        const ordre = ordreArrets(ligne, t.sens);
        const tout = ordre.slice(1).map((a) => {
          const dep = departsActifs(ligne.id, t.sens)[0];
          const h = dep ? heurePassage(dep, ligne, a.id) : null;
          const prix = prixMinPaire(ligne, ordre[0].id, a.id);
          return ligneRow(PREFIXE + "S:" + a.id, a.nom, [h ? T(s, "Arrivée vers ", "Arrival about ") + heureLisible(h) : "", prix ? T(s, "dès ", "from ") + formatFcfa(prix) : ""].filter(Boolean).join(" · "));
        });
        return { texte: T(s, "Trajet " + entete(s) + ".\nÀ quel arrêt descendez-vous ?", "Route " + entete(s) + ".\nAt which stop do you get off?"), liste: liste(s, T(s, "Choisir l'arrêt", "Choose stop"), T(s, "Arrêt de descente", "Stop"), tout) };
      }
      case "montee": {
        const ordre = ordreArrets(ligne, t.sens);
        const iDesc = indexDans(ordre, d.descente);
        const tout = ordre.slice(0, iDesc).map((a, i) => ligneRow(PREFIXE + "S:" + a.id, a.nom, i === 0 ? T(s, "Point de départ", "Starting point") : T(s, "Arrêt intermédiaire", "Intermediate stop")));
        return { texte: T(s, "Vous descendez à " + arretNom(ligne, d.descente) + ".\nÀ quel arrêt montez-vous ?", "You get off at " + arretNom(ligne, d.descente) + ".\nAt which stop do you board?"), liste: liste(s, T(s, "Choisir l'arrêt", "Choose stop"), T(s, "Arrêt de montée", "Boarding stop"), tout) };
      }
      case "date": case "date_retour": {
        const retour = etape === "date_retour";
        const ctx = retour ? ctxRetour(s) : ctxAller(s);
        let jours;
        if (retour) {
          const depAller = departParId(d.depart);
          const hArrivee = depAller ? (heurePassage(depAller, ligne, d.descente) || null) : null;
          jours = joursPossibles(ctx, d.date, hArrivee);
        } else jours = joursPossibles(ctx);
        const tout = jours.map((j) => ligneRow(PREFIXE + "D:" + j.date, formatCourt(j.date, s),
          (j.delta === 0 ? T(s, "Aujourd'hui · ", "Today · ") : j.delta === 1 ? T(s, "Demain · ", "Tomorrow · ") : "") + j.n + (j.n > 1 ? T(s, " départs", " departures") : T(s, " départ", " departure"))));
        const texte = retour
          ? T(s, "Quel jour pour le retour ? (" + arretNom(ligne, d.descente) + " → " + arretNom(ligne, d.montee) + ")", "Which day for the return? (" + arretNom(ligne, d.descente) + " → " + arretNom(ligne, d.montee) + ")")
          : T(s, arretNom(ligne, d.montee) + " → " + arretNom(ligne, d.descente) + ".\nQuel jour souhaitez-vous voyager ?", arretNom(ligne, d.montee) + " → " + arretNom(ligne, d.descente) + ".\nWhich day would you like to travel?");
        if (!tout.length) return { texte: T(s, "Aucun départ n'est disponible à la réservation sur ce trajet pour le moment. Choisissez un autre trajet ou contactez un conseiller.", "No departure is available for booking on this route right now. Pick another route or contact an advisor."), liste: liste(s, T(s, "Choisir", "Choose"), T(s, "Jours", "Days"), []) };
        return { texte, liste: liste(s, T(s, "Choisir le jour", "Choose day"), T(s, "Jours disponibles", "Available days"), tout) };
      }
      case "depart": case "depart_retour": {
        const retour = etape === "depart_retour";
        const ctx = retour ? ctxRetour(s) : ctxAller(s);
        const dateIso = retour ? d.dateRetour : d.date;
        const depAller = departParId(d.depart);
        const apres = retour && dateIso === d.date && depAller ? (heurePassage(depAller, ligne, d.descente) || null) : null;
        const poss = departsPossibles(ctx, dateIso, apres);
        const tout = poss.map((p) => {
          const hDe = heurePassage(p.depart, ligne, ctx.de) || heureNorm(p.depart.heure), hVers = heurePassage(p.depart, ligne, ctx.vers);
          const libres = Math.max.apply(null, p.classes.map((c) => dispoClasse(p.depart, ligne, dateIso, ctx.de, ctx.vers, c.id)));
          const prix = Math.min.apply(null, p.classes.map((c) => tarifPaire(ligne, ctx.de, ctx.vers, c.id).prix));
          return ligneRow(PREFIXE + "H:" + p.depart.id, heureLisible(hDe) + (hVers ? " → " + heureLisible(hVers) : ""),
            T(s, "Dès ", "From ") + formatFcfa(prix) + (libres <= 5 ? T(s, " · plus que " + libres + " place" + (libres > 1 ? "s" : ""), " · only " + libres + " left") : ""));
        });
        return { texte: formatJour(dateIso, s) + (retour ? T(s, " (retour)", " (return)") : "") + ".\n" + T(s, "Quel départ vous convient ?", "Which departure suits you?"), liste: liste(s, T(s, "Choisir le départ", "Choose departure"), T(s, "Départs", "Departures"), tout) };
      }
      case "classe": {
        const dep = departParId(d.depart);
        const tout = ligne.classes.filter((c) => tarifPaire(ligne, d.montee, d.descente, c.id) && dispoClasse(dep, ligne, d.date, d.montee, d.descente, c.id) > 0).map((c) => {
          const tp = tarifPaire(ligne, d.montee, d.descente, c.id);
          return ligneRow(PREFIXE + "C:" + c.id, c.nom, formatFcfa(tp.prix) + (tp.prixAR ? T(s, " · A/R ", " · return ") + formatFcfa(tp.prixAR) : "") + (c.description ? " · " + c.description : ""));
        });
        return { texte: T(s, "Dans quelle classe souhaitez-vous voyager ?", "Which class would you like?"), liste: liste(s, T(s, "Choisir la classe", "Choose class"), T(s, "Classes", "Classes"), tout) };
      }
      case "cote": {
        const dep = departParId(d.depart);
        const f = dispo(dep, ligne, d.date, d.montee, d.descente, d.classe, "fenetre"), c = dispo(dep, ligne, d.date, d.montee, d.descente, d.classe, "couloir");
        const tout = [];
        if (f > 0) tout.push(ligneRow(PREFIXE + "K:fenetre", T(s, "Fenêtre", "Window"), T(s, "Côté fenêtre", "Window side")));
        if (c > 0) tout.push(ligneRow(PREFIXE + "K:couloir", T(s, "Couloir", "Aisle"), T(s, "Côté couloir", "Aisle side")));
        if (f > 0 && c > 0) tout.push(ligneRow(PREFIXE + "K:indiff", T(s, "Peu importe", "No preference"), T(s, "Le plus de places disponibles", "Whatever is most available")));
        return { texte: T(s, "Préférez-vous une place côté fenêtre ou côté couloir ?\n(Le siège exact est attribué par la compagnie selon votre classe et votre choix.)", "Would you prefer a window or an aisle seat?\n(The exact seat is assigned by the operator according to your class and choice.)"), liste: liste(s, T(s, "Choisir le côté", "Choose side"), T(s, "Côté de la place", "Seat side"), tout) };
      }
      case "formule": {
        const tp = tarifPaire(ligne, d.montee, d.descente, d.classe);
        const tout = [
          ligneRow(PREFIXE + "F:simple", T(s, "Aller simple", "One way"), formatFcfa(tp.prix) + T(s, " par personne", " per person")),
          ligneRow(PREFIXE + "F:ar", T(s, "Aller-retour", "Return trip"), formatFcfa(tp.prixAR || tp.prix * 2) + T(s, " par personne", " per person"))
        ];
        return { texte: T(s, "Aller simple ou aller-retour ?", "One way or return trip?"), liste: liste(s, T(s, "Choisir", "Choose"), T(s, "Formule", "Trip type"), tout) };
      }
      case "nb": {
        const max = nbMaxVoyageurs(s);
        const unit = prixUnitaire(s);
        const tout = [];
        for (let n = 1; n <= max; n++) tout.push(ligneRow(PREFIXE + "N:" + n, n + T(s, n > 1 ? " voyageurs" : " voyageur", n > 1 ? " passengers" : " passenger"), formatFcfa(unit * n)));
        return { texte: T(s, "Combien de voyageurs ?", "How many passengers?"), liste: liste(s, T(s, "Choisir", "Choose"), T(s, "Voyageurs", "Passengers"), tout) };
      }
      case "nom": {
        const i = voyageursDe(s).length + 1;
        return { texte: T(s, "Voyageur " + i + " sur " + d.nb + " — nom et prénom, comme sur la pièce d'identité :", "Passenger " + i + " of " + d.nb + " — full name as on the ID:"), liste: null, boutons: [{ id: PREFIXE + "BACK", title: T(s, "◀ Retour", "◀ Back") }] };
      }
      case "cni": {
        return { texte: T(s, "Numéro de CNI (ou de passeport) de " + s.nomEnCours + " :\nIl sert au manifeste de voyage et est conservé de façon sécurisée.", "ID card (or passport) number of " + s.nomEnCours + ":\nIt is used for the travel manifest and stored securely."), liste: null, boutons: [{ id: PREFIXE + "BACK", title: T(s, "◀ Retour", "◀ Back") }] };
      }
      case "recap": {
        return { texte: recapTexte(s) + "\n\n" + T(s, "Confirmez-vous cette réservation ? Vos places seront retenues le temps du paiement.", "Do you confirm this booking? Your seats will be held while you pay."), liste: null,
          boutons: [{ id: PREFIXE + "OUI", title: T(s, "Confirmer", "Confirm") }, { id: PREFIXE + "MOD", title: T(s, "Modifier", "Change") }, { id: PREFIXE + "NON", title: T(s, "Annuler", "Cancel") }] };
      }
      case "billets": {
        const bs = billetsDuClient(s.fromPhone);
        const tout = bs.map((r) => ligneRow(PREFIXE + "B:" + r.id, ref(r), resumeBilletCourt(r, s)));
        return { texte: bs.length ? T(s, "Vos billets à venir. Lequel souhaitez-vous consulter ?", "Your upcoming tickets. Which one would you like to view?") : T(s, "Vous n'avez aucun billet à venir.", "You have no upcoming ticket."), liste: liste(s, T(s, "Choisir", "Choose"), T(s, "Mes billets", "My tickets"), tout) };
      }
      case "billet": {
        const r = reservationParId(s.billetId);
        if (!r) { s.vue = null; return presenterEtape(s); }
        const tout = [];
        if (r.statut === "À payer") tout.push(ligneRow(PREFIXE + "ANN", T(s, "Annuler", "Cancel"), T(s, "Annuler cette réservation", "Cancel this booking")));
        const info = r.statut === "Confirmé"
          ? T(s, "Votre billet est confirmé. Pour une modification, contactez un conseiller.", "Your ticket is confirmed. To change it, contact an advisor.")
          : T(s, "En attente de paiement (places retenues jusqu'à " + heureLocale(r.expireLe) + ").", "Awaiting payment (seats held until " + heureLocale(r.expireLe) + ").");
        return { texte: detailBillet(r, s) + "\n\n" + info + "\n" + T(s, "Que souhaitez-vous faire ?", "What would you like to do?"), liste: liste(s, T(s, "Mes options", "My options"), T(s, "Ce billet", "This ticket"), tout) };
      }
      case "annul": {
        return { texte: T(s, "Voulez-vous vraiment annuler cette réservation ? Les places seront rendues.", "Do you really want to cancel this booking? The seats will be released."), liste: null,
          boutons: [{ id: PREFIXE + "ANNOK", title: T(s, "Oui, annuler", "Yes, cancel") }, { id: PREFIXE + "ANNKO", title: T(s, "Non, la garder", "No, keep it") }] };
      }
    }
    return { texte: "", liste: null };
  }
  function heureLocale(iso) {
    if (!iso) return "";
    const p = sh.partiesFuseau(new Date(iso), fz());
    return (p.heure < 10 ? "0" : "") + p.heure + "h" + (p.minute < 10 ? "0" : "") + p.minute;
  }
  function nbMaxVoyageurs(s) {
    const d = s.d; const t = parseTrajet(d.trajet); const ligne = ligneParId(t.ligneId);
    let max = Math.max(1, Math.min(entierPositif(reg().maxVoyageurs, 4) || 4, 9));
    const dep = departParId(d.depart);
    max = Math.min(max, placesLibresMax(dep, ligne, d.date, d.montee, d.descente, d.classe, d.cote));
    if (d.formule === "ar") {
      const depR = departParId(d.departRetour);
      if (depR) max = Math.min(max, placesLibresMax(depR, ligne, d.dateRetour, d.descente, d.montee, d.classe, d.cote));
    }
    return Math.max(0, max);
  }

  // ---------------- Enchainement automatique des etapes sans choix reel ----------------
  // Renvoie un eventuel texte d'information a placer avant la question suivante.
  function avancer(s) {
    let info = "";
    for (let garde = 0; garde < 12; garde++) {
      const etape = prochaineEtape(s);
      const d = s.d;
      const t = parseTrajet(d.trajet); const ligne = t && ligneParId(t.ligneId);
      if (etape === "montee") {
        const ordre = ordreArrets(ligne, t.sens);
        const iDesc = indexDans(ordre, d.descente);
        if (iDesc <= 1 || reg().choixMontee === false) { d.montee = ordre[0].id; s.auto.montee = true; continue; }
      } else if (etape === "depart" || etape === "depart_retour") {
        const retour = etape === "depart_retour";
        const ctx = retour ? ctxRetour(s) : ctxAller(s);
        const dateIso = retour ? d.dateRetour : d.date;
        const depAller = departParId(d.depart);
        const apres = retour && dateIso === d.date && depAller ? (heurePassage(depAller, ligne, d.descente) || null) : null;
        const poss = departsPossibles(ctx, dateIso, apres);
        if (poss.length === 1) { d[retour ? "departRetour" : "depart"] = poss[0].depart.id; s.auto[retour ? "departRetour" : "depart"] = true; continue; }
        if (!poss.length) { // plus rien ce jour-la (vente close entre-temps) : on revient au choix du jour
          delete d[retour ? "dateRetour" : "date"];
          info = T(s, "Il n'y a plus de départ disponible ce jour-là.", "There is no departure left that day.");
          continue;
        }
      } else if (etape === "classe") {
        const dep = departParId(d.depart);
        const dispos = ligne.classes.filter((c) => tarifPaire(ligne, d.montee, d.descente, c.id) && dispoClasse(dep, ligne, d.date, d.montee, d.descente, c.id) > 0);
        if (dispos.length === 1) { d.classe = dispos[0].id; s.auto.classe = true; continue; }
      } else if (etape === "cote") {
        const dep = departParId(d.depart);
        const classe = classeParId(ligne, d.classe);
        if (!classe || !classe.cote) { d.cote = "total"; s.auto.cote = true; continue; }
        const f = dispo(dep, ligne, d.date, d.montee, d.descente, d.classe, "fenetre"), c = dispo(dep, ligne, d.date, d.montee, d.descente, d.classe, "couloir");
        if (f > 0 && c === 0) { d.cote = "fenetre"; s.auto.cote = true; continue; }
        if (c > 0 && f === 0) { d.cote = "couloir"; s.auto.cote = true; continue; }
      } else if (etape === "formule") {
        const tp = tarifPaire(ligne, d.montee, d.descente, d.classe);
        const retourPossible = tp && tp.prixAR > 0 && joursPossibles(ctxRetour(s), d.date, heurePassage(departParId(d.depart), ligne, d.descente)).length > 0;
        if (!retourPossible) { d.formule = "simple"; s.auto.formule = true; continue; }
      } else if (etape === "date_retour") {
        // La liste des jours est calculee a la presentation ; si aucun retour n'est possible on retombe sur l'aller simple.
        const j = joursPossibles(ctxRetour(s), d.date, heurePassage(departParId(d.depart), ligne, d.descente));
        if (!j.length) { d.formule = "simple"; s.auto.formule = true; info = T(s, "Aucun départ retour n'est disponible : je continue en aller simple.", "No return departure is available: I am continuing with a one-way ticket."); continue; }
      } else if (etape === "nb") {
        const max = nbMaxVoyageurs(s);
        if (max <= 0) { // plus de place (vente concurrente) : on rechoisit le jour
          delete d.date; delete d.depart; delete d.classe; delete d.cote; delete d.formule; delete d.dateRetour; delete d.departRetour; s.auto = {};
          info = T(s, "Il n'y a plus de place disponible sur ce départ. Choisissez un autre jour.", "There is no seat left on this departure. Please choose another day.");
          continue;
        }
        if (max === 1) { d.nb = 1; s.auto.nb = true; continue; }
      } else if (etape === "recap") {
        // revalidation : les places ont pu etre prises entre-temps
        const erreur = verifierPlaces(s);
        if (erreur) {
          delete d.date; delete d.depart; delete d.classe; delete d.cote; delete d.formule; delete d.dateRetour; delete d.departRetour; delete d.nb; s.auto = {};
          info = T(s, "Désolé, il ne reste pas assez de places pour ce choix. Choisissez un autre départ.", "Sorry, there are not enough seats left for this choice. Please choose another departure.");
          continue;
        }
      }
      break;
    }
    return info;
  }
  function verifierPlaces(s, ignorerId) {
    const d = s.d; const t = parseTrajet(d.trajet); const ligne = t && ligneParId(t.ligneId);
    if (!ligne) return "introuvable";
    const dep = departParId(d.depart);
    if (!dep || !circule(dep, d.date) || !achetable(dep, ligne, d.date, d.montee) || !allouer(dep, ligne, d.date, d.montee, d.descente, d.classe, d.cote, d.nb, ignorerId)) return "complet";
    if (d.formule === "ar") {
      const depR = departParId(d.departRetour);
      if (!depR || !circule(depR, d.dateRetour) || !achetable(depR, ligne, d.dateRetour, d.descente) || !allouer(depR, ligne, d.dateRetour, d.descente, d.montee, d.classe, d.cote, d.nb, ignorerId)) return "complet";
    }
    return null;
  }

  function reponseDe(s, prefixe) {
    const p = presenterEtape(s);
    return (prefixe ? prefixe + "\n\n" : "") + p.texte;
  }

  // ---------------- Billets ----------------
  function reservationParId(id) { return state.reservations.filter((r) => String(r.id) === String(id))[0] || null; }
  function billetsDuClient(telephone) {
    if (!state || !telephone) return [];
    expirerReservations();
    const auj = aujourdhuiISO();
    return state.reservations.filter((r) => r.telephone === telephone && (r.statut === "À payer" || r.statut === "Confirmé") && (r.retour ? r.retour.date : r.aller.date) >= auj)
      .sort((a, b) => a.aller.date < b.aller.date ? -1 : 1);
  }
  function resumeBilletCourt(r, session) {
    return formatCourt(r.aller.date, session) + " · " + heureLisible(r.aller.heureDe || "") + " · " + r.aller.deNom + "→" + r.aller.versNom + " · " + r.statut;
  }
  function detailBillet(r, session) {
    const out = [T(session, "Réservation " + ref(r) + " — " + r.statut, "Booking " + ref(r) + " — " + (r.statut === "À payer" ? "to pay" : r.statut === "Confirmé" ? "confirmed" : r.statut))];
    out.push(T(session, "Aller : ", "Outbound: ") + formatJour(r.aller.date, session) + ", " + heureLisible(r.aller.heureDe || "") + " " + r.aller.deNom + " → " + r.aller.versNom + (r.aller.heureVers ? " (" + heureLisible(r.aller.heureVers) + ")" : ""));
    if (r.retour) out.push(T(session, "Retour : ", "Return: ") + formatJour(r.retour.date, session) + ", " + heureLisible(r.retour.heureDe || "") + " " + r.retour.deNom + " → " + r.retour.versNom);
    out.push(T(session, "Classe : ", "Class: ") + r.aller.classeNom + (r.aller.coteDemande && r.aller.coteDemande !== "total" ? " — " + libelleCote(r.aller.coteDemande, session) : ""));
    out.push(T(session, "Voyageurs : ", "Passengers: ") + r.voyageurs.map((v) => v.nom + " (CNI " + v.cniMasque + ")").join(", "));
    out.push(T(session, "Total : ", "Total: ") + formatFcfa(r.total));
    return out.join("\n");
  }
  function nbBilletsAVenir(telephone) { return billetsDuClient(telephone).length; }
  function detailBilletsAVenir(telephone) {
    const bs = billetsDuClient(telephone);
    if (!bs.length) return "";
    const s = sessions[telephone] || { langue: "fr" };
    return bs.slice(0, 3).map((r) => detailBillet(r, s)).join("\n\n");
  }

  function creerJambe(ligne, depart, dateIso, deId, versId, classeId, coteDemande, cotes, session) {
    const classe = classeParId(ligne, classeId);
    return {
      departId: depart.id, date: dateIso, de: deId, vers: versId, deNom: arretNom(ligne, deId), versNom: arretNom(ligne, versId),
      heureDe: heurePassage(depart, ligne, deId) || heureNorm(depart.heure), heureVers: heurePassage(depart, ligne, versId) || null,
      classeId, classeNom: classe ? classe.nom : classeId, coteDemande, cotes
    };
  }
  function confirmerReservation(s) {
    expirerReservations();
    const d = s.d; const t = parseTrajet(d.trajet); const ligne = ligneParId(t.ligneId);
    const dejaAPayer = state.reservations.filter((r) => r.telephone === s.fromPhone && r.statut === "À payer").length;
    if (dejaAPayer >= MAX_A_PAYER_PAR_TELEPHONE) {
      return T(s, "Vous avez déjà " + dejaAPayer + " réservations en attente de paiement. Réglez ou annulez l'une d'elles (« Mes billets ») avant d'en faire une nouvelle.", "You already have " + dejaAPayer + " bookings awaiting payment. Pay or cancel one of them (\"My tickets\") before making a new one.");
    }
    if (verifierPlaces(s)) {
      const info = avancer(s);
      return reponseDe(s, info || T(s, "Désolé, ces places ne sont plus disponibles. Choisissez un autre départ.", "Sorry, these seats are no longer available. Please choose another departure."));
    }
    const dep = departParId(d.depart);
    const cotesAller = allouer(dep, ligne, d.date, d.montee, d.descente, d.classe, d.cote, d.nb);
    const aller = creerJambe(ligne, dep, d.date, d.montee, d.descente, d.classe, d.cote, cotesAller, s);
    let retour = null;
    if (d.formule === "ar") {
      const depR = departParId(d.departRetour);
      retour = creerJambe(ligne, depR, d.dateRetour, d.descente, d.montee, d.classe, d.cote, allouer(depR, ligne, d.dateRetour, d.descente, d.montee, d.classe, d.cote, d.nb), s);
    }
    const maintenant = new Date();
    const unit = prixUnitaire(s);
    const r = {
      id: state.nextId++, telephone: s.fromPhone, fromWhatsapp: s.fromPhone === PHONE_SIMULATEUR ? PHONE_SIMULATEUR : null,
      statut: "À payer", creeLe: maintenant.toISOString(), expireLe: new Date(maintenant.getTime() + entierPositif(reg().delaiRetenueMinutes, 120) * 60000).toISOString(),
      ligneId: ligne.id, ligneNom: ligne.nom, formule: d.formule, nb: d.nb, prixUnitaire: unit, total: unit * d.nb,
      voyageurs: voyageursDe(s).map((v) => ({ nom: v.nom, cniChiffre: v.cniChiffre, cniMasque: v.cniMasque })),
      aller, retour, langue: sh.langueSession(s), historique: [{ le: maintenant.toISOString(), statut: "À payer", par: "client", raison: "" }]
    };
    state.reservations.push(r);
    saveState();
    // Parcours termine : on repart de zero (la langue est conservee) ; la liste d'accueil n'est pas rattachee a ce message.
    sessions[s.fromPhone] = Object.assign(freshSession(s), { fromPhone: s.fromPhone, accueilFait: true, sansListe: true, dernierBilletId: r.id });
    const en = sh.langueSession(s) === "en";
    const note = en ? (reg().notePaiementEn || reg().notePaiement) : (reg().notePaiement || reg().notePaiementEn);
    return T(s,
      "Réservation enregistrée : " + ref(r) + " — statut : à payer.\nVos places sont retenues jusqu'à " + heureLocale(r.expireLe) + ". Montant à régler : " + formatFcfa(r.total) + ".\n" + (note || "") + "\nPour retrouver ou annuler cette réservation, écrivez « mes billets ».",
      "Booking saved: " + ref(r) + " — status: to pay.\nYour seats are held until " + heureLocale(r.expireLe) + ". Amount due: " + formatFcfa(r.total) + ".\n" + (note || "") + "\nTo find or cancel this booking, write \"my tickets\".");
  }

  // ---------------- Traitement d'un message ----------------
  function jetonDepuisTexte(s, texte) {
    const p = presenterEtape(s);
    if (!p.liste) return null;
    const n = norm(texte);
    if (!n) return null;
    const lignes = p.liste.tout.filter((r) => r.id.indexOf(PREFIXE + "PLUS:") !== 0);
    if (/^\d{1,2}$/.test(n)) { const x = lignes[Number(n) - 1]; if (x) return x.id; }
    const exact = lignes.filter((r) => norm(r.title) === n);
    if (exact.length === 1) return exact[0].id;
    const proches = lignes.filter((r) => { const tn = norm(r.title); return tn.indexOf(n) !== -1 || (n.length > 3 && n.indexOf(tn) !== -1); });
    if (proches.length === 1) return proches[0].id;
    // dates tapees
    const mots = { "aujourd'hui": 0, "aujourdhui": 0, "today": 0, "demain": 1, "tomorrow": 1 };
    if (mots[n] !== undefined) { const iso = dt.ajouterJours(aujourdhuiISO(), mots[n]); const r = lignes.filter((x) => x.id === PREFIXE + "D:" + iso)[0]; if (r) return r.id; }
    const m = n.match(/^(\d{1,2})[\/.-](\d{1,2})$/);
    if (m) { const iso = dt.iso(Number(aujourdhuiISO().slice(0, 4)), Number(m[2]), Number(m[1])); const r = lignes.filter((x) => x.id === PREFIXE + "D:" + iso)[0]; if (r) return r.id; }
    return null;
  }

  function gererJeton(s, jeton) {
    const etape = prochaineEtape(s);
    const corps = jeton.slice(PREFIXE.length);
    const [cle, ...reste] = corps.split(":");
    const val = reste.join(":");
    const d = s.d;
    s.sansListe = false;
    const perime = () => reponseDe(s, T(s, "Cette liste n'est plus d'actualité. Voici la question en cours :", "This list is no longer current. Here is the current question:"));

    if (cle === "BACK") {
      if (s.vue) retourVue(s); else retourParcours(s);
      return reponseDe(s);
    }
    if (cle === "PLUS") { s.page = Number(val) || 0; return reponseDe(s); }
    if (cle === "MB") { return afficherMesBillets(s); }
    if (cle === "NON") { // abandon complet du parcours en cours
      const langue = s.langue; sessions[s.fromPhone] = Object.assign(freshSession(s), { fromPhone: s.fromPhone, accueilFait: true, langue });
      return reponseDe(sessions[s.fromPhone], T(s, "D'accord, réservation annulée. Je reste à votre disposition.", "Alright, booking cancelled. I remain at your disposal."));
    }
    if (cle === "MOD") { // on garde l'identite des voyageurs (preremplie au prochain choix du nombre), on rechoisit le trajet
      s.memoire = voyageursDe(s).slice();
      ["trajet", "descente", "montee", "date", "depart", "classe", "cote", "formule", "dateRetour", "departRetour", "nb"].forEach((k) => delete s.d[k]);
      s.d.voyageurs = []; s.nomEnCours = null; s.auto = {}; s.page = 0;
      return reponseDe(s, T(s, "D'accord, reprenons le trajet.", "Alright, let's go over the trip again."));
    }
    if (cle === "OUI") {
      if (etape !== "recap") return perime();
      return confirmerReservation(s);
    }
    // ---- billets ----
    if (cle === "B") {
      const r = reservationParId(val);
      if (!r || r.telephone !== s.fromPhone || billetsDuClient(s.fromPhone).indexOf(r) === -1) return perime();
      s.vue = "billet"; s.billetId = r.id; s.page = 0;
      return reponseDe(s);
    }
    if (cle === "ANN") { if (etape !== "billet") return perime(); s.vue = "annul"; return reponseDe(s); }
    if (cle === "ANNKO") { if (etape !== "annul") return perime(); s.vue = "billet"; return reponseDe(s); }
    if (cle === "ANNOK") {
      if (etape !== "annul") return perime();
      const r = reservationParId(s.billetId);
      if (!r || r.telephone !== s.fromPhone) return perime();
      if (r.statut !== "À payer") { s.vue = "billet"; return reponseDe(s, T(s, "Cette réservation est déjà confirmée : contactez un conseiller pour la modifier.", "This booking is already confirmed: contact an advisor to change it.")); }
      changerStatut(r, "Annulé", "client", "Annulée par le client");
      saveState();
      s.vue = null; s.billetId = null; s.accueilFait = true; s.sansListe = true;
      return T(s, "Votre réservation " + ref(r) + " est annulée, les places ont été rendues.", "Your booking " + ref(r) + " is cancelled, the seats have been released.");
    }

    // ---- choix du parcours ----
    const attendu = { T: "idle", S: etape === "montee" ? "montee" : "descente", D: etape === "date_retour" ? "date_retour" : "date", H: etape === "depart_retour" ? "depart_retour" : "depart", C: "classe", K: "cote", F: "formule", N: "nb" }[cle];
    if (!attendu || attendu !== etape) return perime();
    s.page = 0;
    const t = parseTrajet(d.trajet);
    const ligne = t && ligneParId(t.ligneId);
    if (cle === "T") {
      const x = trajetsListe().filter((y) => y.id === val)[0];
      if (!x) return perime();
      d.trajet = val; s.accueilFait = true;
    } else if (cle === "S") {
      const ordre = ordreArrets(ligne, t.sens);
      const i = indexDans(ordre, val);
      if (etape === "descente") { if (i < 1) return perime(); d.descente = val; }
      else { if (i < 0 || i >= indexDans(ordre, d.descente)) return perime(); d.montee = val; }
    } else if (cle === "D") {
      if (!dateIsoValide(val)) return perime();
      const retour = etape === "date_retour";
      const ctx = retour ? ctxRetour(s) : ctxAller(s);
      const depAller = departParId(d.depart);
      const jours = joursPossibles(ctx, retour ? d.date : null, retour && depAller ? heurePassage(depAller, ligne, d.descente) : null);
      if (!jours.some((j) => j.date === val)) return perime();
      d[retour ? "dateRetour" : "date"] = val;
    } else if (cle === "H") {
      const retour = etape === "depart_retour";
      const ctx = retour ? ctxRetour(s) : ctxAller(s);
      const dateIso = retour ? d.dateRetour : d.date;
      const depAller = departParId(d.depart);
      const apres = retour && dateIso === d.date && depAller ? (heurePassage(depAller, ligne, d.descente) || null) : null;
      if (!departsPossibles(ctx, dateIso, apres).some((p) => p.depart.id === val)) return perime();
      d[retour ? "departRetour" : "depart"] = val;
    } else if (cle === "C") {
      const dep = departParId(d.depart);
      if (!ligne.classes.some((c) => c.id === val) || dispoClasse(dep, ligne, d.date, d.montee, d.descente, val) <= 0) return perime();
      d.classe = val;
    } else if (cle === "K") {
      if (["fenetre", "couloir", "indiff"].indexOf(val) === -1) return perime();
      const dep = departParId(d.depart);
      if (dispo(dep, ligne, d.date, d.montee, d.descente, d.classe, val) <= 0) return perime();
      d.cote = val;
    } else if (cle === "F") {
      if (val !== "simple" && val !== "ar") return perime();
      d.formule = val;
    } else if (cle === "N") {
      const n = Number(val);
      if (!(n >= 1 && n <= nbMaxVoyageurs(s))) return perime();
      d.nb = n; d.voyageurs = (s.memoire || []).slice(0, n); s.nomEnCours = null; s.memoire = null;
    }
    const info = avancer(s);
    return reponseDe(s, info);
  }
  function afficherMesBillets(s) {
    s.sansListe = false; s.page = 0;
    const bs = billetsDuClient(s.fromPhone);
    if (!bs.length) { s.vue = null; return reponseDe(s, T(s, "Vous n'avez aucun billet à venir.", "You have no upcoming ticket.")); }
    if (bs.length === 1) { s.vue = "billet"; s.billetId = bs[0].id; } else { s.vue = "billets"; s.billetId = null; }
    return reponseDe(s);
  }

  function validerNom(texte) {
    const nom = String(texte || "").replace(/\s+/g, " ").trim();
    if (nom.length < 2 || nom.length > 60) return null;
    if (!/^[\p{L}][\p{L} '’.\-]*$/u.test(nom)) return null;
    return nom;
  }
  function validerCni(texte) {
    const c = String(texte || "").replace(/[\s.\-\/]/g, "").toUpperCase();
    return /^[A-Z0-9]{5,20}$/.test(c) ? c : null;
  }

  function processMessage(session, text) {
    const brut = String(text == null ? "" : text).trim();
    const etape = prochaineEtape(session);
    session.sansListe = false;

    if (brut.indexOf(PREFIXE) === 0) return gererJeton(session, brut);

    // Saisies libres
    if (etape === "nom") {
      if (RE_RETOUR.test(norm(brut))) return gererJeton(session, PREFIXE + "BACK");
      const nom = validerNom(brut);
      if (!nom) return T(session, "Je n'ai pas bien lu ce nom. Écrivez le nom et le prénom du voyageur (lettres uniquement).", "I could not read that name. Please write the passenger's full name (letters only).");
      session.nomEnCours = nom;
      return reponseDe(session);
    }
    if (etape === "cni") {
      if (RE_RETOUR.test(norm(brut))) return gererJeton(session, PREFIXE + "BACK");
      const cni = validerCni(brut);
      if (!cni) return T(session, "Ce numéro ne semble pas valide (5 à 20 chiffres ou lettres). Merci de le saisir à nouveau.", "That number does not look valid (5 to 20 digits or letters). Please enter it again.");
      const masque = cniMasque(cni);
      const doublon = voyageursDe(session).some((v) => v.cniMasque === masque && cryptoUtil.dechiffrer(v.cniChiffre) === cni);
      if (doublon) return T(session, "Ce numéro a déjà été saisi pour un autre voyageur de cette réservation. Vérifiez-le.", "That number was already entered for another passenger of this booking. Please check it.");
      voyageursDe(session).push({ nom: session.nomEnCours, cniChiffre: cryptoUtil.chiffrer(cni), cniMasque: masque });
      session.nomEnCours = null;
      const info = avancer(session);
      return reponseDe(session, info);
    }

    const n = norm(brut);
    if (RE_BILLETS.test(n)) return afficherMesBillets(session);
    if (RE_RETOUR.test(n) && etape !== "idle") return gererJeton(session, PREFIXE + "BACK");
    if (RE_RECOMMENCER.test(n)) {
      if (etape === "billet") return gererJeton(session, PREFIXE + "ANN");
      if (etape === "recap" || session.d.trajet) return gererJeton(session, PREFIXE + "NON");
    }
    const jeton = jetonDepuisTexte(session, brut);
    if (jeton) return gererJeton(session, jeton);
    if (etape === "recap" || etape === "annul") {
      if (sh.parseAffirmative(brut)) return gererJeton(session, PREFIXE + (etape === "recap" ? "OUI" : "ANNOK"));
      if (sh.parseNegative(brut)) return gererJeton(session, PREFIXE + (etape === "recap" ? "NON" : "ANNKO"));
    }
    if (etape === "idle") { // salutation ou texte sans rapport : on presente l'accueil
      return reponseDe(session);
    }
    return reponseDe(session, T(session, "Je n'ai pas compris votre choix. Voici la question en cours :", "I did not understand your choice. Here is the current question:"));
  }

  // ---------------- Point d'entree ----------------
  function handleMessage(fromPhone, text, opts) {
    const reponse = traiterMessage(fromPhone, text, opts);
    if (reponse && sessions[fromPhone]) sessions[fromPhone].derniereReponse = reponse;
    persistance.enregistrer(fromPhone);
    return reponse;
  }
  function reponseDeReprise(fromPhone) {
    const s = sessions[fromPhone];
    if (!s || !s.derniereReponse) return null;
    return prochaineEtape(s) !== "idle" ? s.derniereReponse : null;
  }
  // Texte journalise pour un message du client : jamais de CNI en clair, jetons remplaces par le libelle choisi.
  function texteJournalisable(session, text) {
    const etape = session ? prochaineEtape(session) : "idle";
    if (etape === "cni") { const c = validerCni(text); return c ? "[CNI " + cniMasque(c) + "]" : "[CNI]"; }
    if (String(text).indexOf(PREFIXE) === 0) {
      const p = session ? presenterEtape(session) : null;
      const ligneChoisie = p && p.liste ? p.liste.tout.filter((r) => r.id === text)[0] : null;
      if (ligneChoisie) return ligneChoisie.title;
      const b = p && p.boutons ? p.boutons.filter((x) => x.id === text)[0] : null;
      return b ? b.title : text.slice(PREFIXE.length);
    }
    return text;
  }
  function traiterMessage(fromPhone, text, opts) {
    if (!state) return sh.t(sessions[fromPhone], "Le service redémarre, un instant s'il vous plaît...", "The service is restarting, one moment please...");
    expirerReservations();
    if (!(opts && opts.sansJournalClient)) journaliser(fromPhone, "client", texteJournalisable(sessions[fromPhone], text));

    const sessionExistante = sessions[fromPhone];
    if (sessionExistante && sessionExistante.attenteChoixContactHumain) {
      sessionExistante.attenteChoixContactHumain = false;
      const veutAppel = sh.detecteChoixAppel(text);
      const texteOrigine = sessionExistante.texteDemandeHumainOrigine || text;
      delete sessionExistante.texteDemandeHumainOrigine;
      sh.ajouterMessageHistorique(conversationsHumain, fromPhone, "client", text);
      if (veutAppel) notifierMarchand("humain", [fromPhone, sh.PREFIXE_PREFERENCE_APPEL + texteOrigine]).catch((e) => console.error("[" + merchantKey + "] Echec de la notification marchand (appel) :", e));
      const msgHumain = veutAppel ? sh.messageMiseEnRelationAppel(sessionExistante) : sh.messageMiseEnRelation(sessionExistante);
      journaliser(fromPhone, "bot", msgHumain);
      return msgHumain;
    }
    if (sh.pauseHumainActive(conversationsHumain, fromPhone)) {
      sh.ajouterMessageHistorique(conversationsHumain, fromPhone, "client", text);
      return null;
    }
    const reprisePauseHumain = sh.consommerSignalReprise(conversationsHumain, fromPhone);
    const session = getSession(fromPhone);

    if (session.langue == null) {
      if (!session.gateLangueEnvoyee) {
        session.gateLangueEnvoyee = true;
        session.texteAvantLangue = text;
        const reponseGate = sh.messageChoixLangue();
        journaliser(fromPhone, "bot", reponseGate);
        return reponseGate;
      }
      session.langue = sh.detecterChoixLangueInitial(text) || "fr";
      if (session.texteAvantLangue) { text = session.texteAvantLangue; delete session.texteAvantLangue; }
    }
    const changementLangue = sh.detecterChangementLangue(text);
    if (changementLangue && changementLangue !== session.langue) {
      session.langue = changementLangue;
      let conf = sh.t(session, "Très bien, je continue en français. 🇫🇷", "Sure, I'll continue in English. 🇬🇧");
      if (reprisePauseHumain) conf = sh.messageReprisePause(session) + "\n\n" + conf;
      journaliser(fromPhone, "bot", conf);
      return conf;
    }
    const estPremierContact = !humanHintDonne[fromPhone];
    const etapeLibre = prochaineEtape(session) === "nom" || prochaineEtape(session) === "cni";
    if ((!etapeLibre || /\b(conseiller|humain|human|advisor|agent)\b/i.test(String(text)) && String(text).split(/\s+/).length >= 2) && sh.demandeUnHumain(text) && String(text).indexOf(PREFIXE) !== 0) {
      session.attenteChoixContactHumain = true;
      session.texteDemandeHumainOrigine = text;
      sh.demarrerPauseHumain(conversationsHumain, fromPhone, text);
      notifierMarchand("humain", [fromPhone, text]).catch((e) => console.error("[" + merchantKey + "] Echec de la notification marchand (humain) :", e));
      let msgChoix = sh.messageChoixContact(session);
      if (reprisePauseHumain) msgChoix = sh.messageReprisePause(session) + "\n\n" + msgChoix;
      journaliser(fromPhone, "bot", msgChoix);
      return msgChoix;
    }

    let reponse = processMessage(session, String(text == null ? "" : text));
    if (estPremierContact && reponse) { humanHintDonne[fromPhone] = true; reponse += sh.mentionHumainDisponible(session); }
    if (reprisePauseHumain && reponse) reponse = sh.messageReprisePause(session) + "\n\n" + reponse;
    journaliser(fromPhone, "bot", reponse);
    return reponse;
  }

  // ---------------- Conversations avec un humain, langue, etat ----------------
  function getConversationsEnAttente() { return sh.listerConversationsEnAttente(conversationsHumain); }
  async function repondreConversationHumain(telephone, message) {
    const ok = sh.repondreHumain(conversationsHumain, telephone, message);
    if (!ok) return false;
    await envoyer(telephone, message);
    journaliser(telephone, "marchand", message);
    return true;
  }
  function definirLangueSession(fromPhone, langue) {
    const s = getSession(fromPhone);
    s.langue = langue === "en" ? "en" : "fr";
    s.gateLangueEnvoyee = true;
    delete s.texteAvantLangue;
    persistance.enregistrer(fromPhone);
    return s.langue;
  }
  function estEnPauseHumain(fromPhone) {
    const c = conversationsHumain[fromPhone];
    if (!c || !c.enAttente) return false;
    return (Date.now() - new Date(c.depuisISO).getTime()) < sh.DUREE_PAUSE_HUMAIN_MS;
  }
  function langueDeSession(fromPhone) { const s = sessions[fromPhone]; return s ? sh.langueSession(s) : null; }

  // Etat lu par server.js pour construire la liste / les boutons de la reponse qui vient d'etre calculee.
  function getEtatSession(fromPhone) {
    const s = sessions[fromPhone];
    if (!s || !state) return null;
    const etape = prochaineEtape(s);
    let p = null;
    try { p = s.sansListe ? null : presenterEtape(s); } catch (e) { p = null; }
    return {
      stage: etape,
      pretPourChoix: false,
      transport: true,
      liste: p && p.liste ? { bouton: p.liste.bouton, section: p.liste.section, lignes: p.liste.lignes, retour: p.liste.retour } : null,
      boutons: p && p.boutons ? p.boutons : null,
      langue: sh.langueSession(s)
    };
  }

  // ---------------- API pour /admin ----------------
  function getLignes() { return state ? state.lignes : []; }
  function getDeparts() { return state ? state.departs : []; }
  function getSettings() { return state ? state.settings : {}; }

  function proprePasses(passages, arretsIds) {
    const out = {};
    Object.keys(passages || {}).forEach((k) => { if (arretsIds.indexOf(k) !== -1 && heureValide(passages[k])) out[k] = heureNorm(passages[k]); });
    return out;
  }
  function updateLignes(liste) {
    if (!state || !Array.isArray(liste)) return { erreur: "Corps de requête invalide (tableau attendu)." };
    const propres = []; const vus = new Set();
    for (let i = 0; i < liste.length; i++) {
      const l = liste[i] || {};
      const nom = String(l.nom == null ? "" : l.nom).trim().slice(0, 80);
      if (!nom) continue;
      let id = idPropre(l.id, "l" + Date.now().toString(36) + i);
      while (vus.has(id)) id += "x"; vus.add(id);
      const arrets = []; const arVus = new Set();
      (Array.isArray(l.arrets) ? l.arrets : []).forEach((a, j) => {
        const an = String((a && a.nom) == null ? "" : a.nom).trim().slice(0, 60); if (!an) return;
        let aid = idPropre(a.id, "a" + Date.now().toString(36) + j);
        while (arVus.has(aid)) aid += "x"; arVus.add(aid);
        arrets.push({ id: aid, nom: an, pk: Number.isFinite(Number(a.pk)) ? Number(a.pk) : 0 });
      });
      if (arrets.length < 2) return { erreur: "La ligne « " + nom + " » doit avoir au moins deux arrêts." };
      const classes = []; const clVus = new Set();
      (Array.isArray(l.classes) ? l.classes : []).forEach((c, j) => {
        const cn = String((c && c.nom) == null ? "" : c.nom).trim().slice(0, 40); if (!cn) return;
        let cid = idPropre(c.id, "c" + Date.now().toString(36) + j);
        while (clVus.has(cid)) cid += "x"; clVus.add(cid);
        classes.push({ id: cid, nom: cn, cote: c.cote === true || c.cote === "true", description: String(c.description || "").trim().slice(0, 40) });
      });
      if (!classes.length) return { erreur: "La ligne « " + nom + " » doit avoir au moins une classe." };
      const aIds = arrets.map((a) => a.id), cIds = classes.map((c) => c.id);
      const tarifs = [];
      (Array.isArray(l.tarifs) ? l.tarifs : []).forEach((t) => {
        if (!t || aIds.indexOf(t.de) === -1 || aIds.indexOf(t.vers) === -1 || cIds.indexOf(t.classeId) === -1) return;
        if (aIds.indexOf(t.de) >= aIds.indexOf(t.vers)) return; // paire dans l'ordre de la ligne
        const prix = entierPositif(t.prix, 0), prixAR = entierPositif(t.prixAR, 0);
        if (!prix) return;
        tarifs.push({ de: t.de, vers: t.vers, classeId: t.classeId, prix, prixAR });
      });
      propres.push({ id, nom, mode: ["train", "navette", "car", "autre"].indexOf(l.mode) !== -1 ? l.mode : "autre", actif: l.actif !== false, arrets, classes, tarifs });
    }
    state.lignes = propres;
    // Les departs dont la ligne a disparu sont retires de la vue (conserves s'ils ont des reservations : ils restent dans l'etat).
    saveState();
    return { lignes: state.lignes };
  }
  function genererTarifs(ligneId, base) {
    const ligne = ligneParId(ligneId);
    if (!ligne) return { erreur: "Ligne introuvable." };
    ligne.tarifs = calculerTarifs(ligne, base || {});
    saveState();
    return { ligne };
  }
  function updateDeparts(liste) {
    if (!state || !Array.isArray(liste)) return { erreur: "Corps de requête invalide (tableau attendu)." };
    const propres = []; const vus = new Set();
    for (let i = 0; i < liste.length; i++) {
      const x = liste[i] || {};
      const ligne = ligneParId(x.ligneId);
      if (!ligne) return { erreur: "Départ " + (i + 1) + " : ligne inconnue." };
      if (!heureValide(x.heure)) return { erreur: "Départ " + (i + 1) + " : heure invalide (HH:MM)." };
      let id = idPropre(x.id, "d" + Date.now().toString(36) + i);
      while (vus.has(id)) id += "x"; vus.add(id);
      const aIds = ligne.arrets.map((a) => a.id);
      const quotas = {};
      ligne.classes.forEach((c) => {
        const q = (x.quotas && x.quotas[c.id]) || {};
        quotas[c.id] = c.cote ? { fenetre: entierPositif(q.fenetre, 0), couloir: entierPositif(q.couloir, 0) } : { total: entierPositif(q.total, 0) };
      });
      const jours = Array.isArray(x.jours) ? x.jours.map(Number).filter((j) => j >= 0 && j <= 6) : [0, 1, 2, 3, 4, 5, 6];
      const fermes = (Array.isArray(x.fermes) ? x.fermes : []).filter(dateIsoValide);
      propres.push({
        id, ligneId: ligne.id, sens: x.sens === -1 || x.sens === "-1" ? -1 : 1, heure: heureNorm(x.heure), passages: proprePasses(x.passages, aIds),
        jours: jours.length ? jours : [0, 1, 2, 3, 4, 5, 6], fermes, debut: dateIsoValide(x.debut) ? x.debut : null, fin: dateIsoValide(x.fin) ? x.fin : null,
        actif: x.actif !== false, quotas
      });
    }
    state.departs = propres;
    saveState();
    return { departs: state.departs };
  }
  function updateSettings(patch) {
    if (!state || !patch || typeof patch !== "object") return null;
    const s = state.settings;
    ["delaiRetenueMinutes", "clotureAvantDepartMinutes", "avanceMaxJours", "maxVoyageurs"].forEach((k) => {
      if (patch[k] !== undefined) { const n = parseInt(patch[k], 10); if (Number.isFinite(n) && n >= 0) s[k] = k === "maxVoyageurs" ? Math.max(1, Math.min(n, 9)) : Math.min(n, 100000); }
    });
    if (patch.choixMontee !== undefined) s.choixMontee = patch.choixMontee === true || patch.choixMontee === "true";
    ["notePaiement", "notePaiementEn", "consigne", "consigneEn", "autoConfirmMessage", "autoConfirmMessageEn"].forEach((k) => {
      if (patch[k] !== undefined) s[k] = String(patch[k] == null ? "" : patch[k]).slice(0, 500);
    });
    if (patch.fuseau !== undefined && sh.fuseauValide(patch.fuseau)) s.fuseau = patch.fuseau;
    saveState();
    return s;
  }
  function chargerExemple() {
    if (!state) return { erreur: "Service indisponible." };
    if (state.lignes.length || state.departs.length) return { erreur: "dejaRempli", message: "Des lignes existent déjà : l'exemple ne remplace jamais vos données." };
    const ex = donneesExemple();
    state.lignes = ex.lignes; state.departs = ex.departs;
    saveState();
    return { lignes: state.lignes, departs: state.departs };
  }

  // ---- Reservations (vue admin) : CNI toujours masquee ----
  function vueReservation(r) {
    expirerReservations();
    return {
      id: r.id, reference: ref(r), statut: r.statut, creeLe: r.creeLe, expireLe: r.expireLe, telephone: r.telephone, fromWhatsapp: r.fromWhatsapp || null,
      ligneId: r.ligneId, ligneNom: r.ligneNom, formule: r.formule, nb: r.nb, total: r.total, prixUnitaire: r.prixUnitaire,
      voyageurs: r.voyageurs.map((v) => ({ nom: v.nom, cni: v.cniMasque })), aller: r.aller, retour: r.retour || null, historique: r.historique || []
    };
  }
  function getReservations(filtre) {
    if (!state) return [];
    expirerReservations();
    const f = filtre || {};
    return state.reservations.filter((r) => {
      if (f.statut && r.statut !== f.statut) return false;
      if (f.departId && !jambes(r).some((l) => l.departId === f.departId && (!f.date || l.date === f.date))) return false;
      if (f.date && !f.departId && !jambes(r).some((l) => l.date === f.date)) return false;
      return true;
    }).sort((a, b) => b.id - a.id).map(vueReservation);
  }
  function getReservationParId(id) { const r = reservationParId(id); return r ? vueReservation(r) : null; }
  function changerStatut(r, nouveau, par, raison) {
    r.statut = nouveau;
    r.historique = (r.historique || []).concat([{ le: new Date().toISOString(), statut: nouveau, par: par || null, raison: raison || "" }]);
    if (nouveau === "Confirmé") r.confirmeLe = new Date().toISOString();
  }
  function updateReservationStatut(id, nouveau, raison, par) {
    expirerReservations();
    const r = reservationParId(id);
    if (!r) return null;
    if (STATUTS_VALIDES.indexOf(nouveau) === -1) return { erreur: "statut", message: "Statut invalide." };
    if (r.statut === nouveau) return vueReservation(r);
    if (nouveau === "Confirmé" && STATUTS_BLOQUANTS.indexOf(r.statut) === -1) {
      // la retenue a expire ou la reservation a ete annulee : on reverifie que les places sont encore libres
      const ligne = ligneParId(r.ligneId);
      const ok = ligne && jambes(r).every((leg) => {
        const dep = departParId(leg.departId);
        return dep && allouer(dep, ligne, leg.date, leg.de, leg.vers, leg.classeId, leg.coteDemande, r.nb, r.id);
      });
      if (!ok) return { erreur: "occupe", message: "Les places de cette réservation ne sont plus disponibles (retenue expirée)." };
      jambes(r).forEach((leg) => {
        const dep = departParId(leg.departId);
        leg.cotes = allouer(dep, ligne, leg.date, leg.de, leg.vers, leg.classeId, leg.coteDemande, r.nb, r.id);
      });
    }
    changerStatut(r, nouveau, par, raison);
    if (nouveau === "À payer") r.expireLe = new Date(Date.now() + entierPositif(reg().delaiRetenueMinutes, 120) * 60000).toISOString();
    saveState();
    return vueReservation(r);
  }
  // Texte du billet a envoyer au client (action EXPLICITE de l'equipe depuis /admin ; aucun envoi automatique).
  function texteBillet(id) {
    const r = reservationParId(id);
    if (!r) return null;
    const session = { langue: r.langue || "fr" };
    const en = sh.langueSession(session) === "en";
    const consigne = en ? (reg().consigneEn || reg().consigne) : (reg().consigne || reg().consigneEn);
    const fin = en ? (reg().autoConfirmMessageEn || reg().autoConfirmMessage) : (reg().autoConfirmMessage || reg().autoConfirmMessageEn);
    return detailBillet(r, session) + (consigne ? "\n\n" + consigne : "") + (fin ? "\n" + fin : "");
  }
  async function envoyerBillet(id) {
    const r = reservationParId(id);
    if (!r) return { erreur: "introuvable" };
    if (r.statut !== "Confirmé" && r.statut !== "Embarqué") return { erreur: "statut", message: "Seul un billet confirmé peut être envoyé." };
    if (!r.telephone || r.telephone === PHONE_SIMULATEUR) return { erreur: "telephone", message: "Pas de numéro WhatsApp pour cette réservation." };
    const texte = texteBillet(id);
    await envoyer(r.telephone, texte);
    journaliser(r.telephone, "marchand", texte);
    r.billetEnvoyeLe = new Date().toISOString();
    saveState();
    return { ok: true };
  }

  // ---- Manifeste d'un depart : seul endroit ou la CNI est dechiffree ----
  function getManifeste(departId, dateIso, avecCni) {
    if (!state) return null;
    const dep = departParId(departId);
    if (!dep || !dateIsoValide(dateIso)) return null;
    const ligne = ligneParId(dep.ligneId);
    if (!ligne) return null;
    expirerReservations();
    const ordre = ordreArrets(ligne, dep.sens);
    const passagers = [];
    state.reservations.filter((r) => r.statut === "Confirmé" || r.statut === "Embarqué" || r.statut === "À payer").forEach((r) => {
      jambes(r).forEach((leg) => {
        if (leg.departId !== departId || leg.date !== dateIso) return;
        r.voyageurs.forEach((v, i) => {
          const cotes = Object.keys(leg.cotes || {}).filter((k) => leg.cotes[k] > 0);
          passagers.push({
            reference: ref(r), statut: r.statut, nom: v.nom, cni: avecCni ? (cryptoUtil.dechiffrer(v.cniChiffre) || "") : v.cniMasque,
            telephone: r.telephone, classe: leg.classeNom, cote: leg.coteDemande === "total" ? "" : (cotes.length === 1 ? cotes[0] : leg.coteDemande),
            monte: leg.deNom, descend: leg.versNom, ordreMonte: indexDans(ordre, leg.de)
          });
        });
      });
    });
    passagers.sort((a, b) => a.ordreMonte - b.ordreMonte || (a.nom < b.nom ? -1 : 1));
    return { departId, date: dateIso, ligne: ligne.nom, heure: dep.heure, sens: dep.sens, passagers };
  }
  // Occupation troncon par troncon d'un depart pour une date (ecran « Departs » de l'admin).
  function getOccupation(departId, dateIso) {
    if (!state) return null;
    const dep = departParId(departId);
    if (!dep || !dateIsoValide(dateIso)) return null;
    const ligne = ligneParId(dep.ligneId);
    if (!ligne) return null;
    expirerReservations();
    const ordre = ordreArrets(ligne, dep.sens);
    const actifs = actives();
    const troncons = [];
    for (let seg = 0; seg < ordre.length - 1; seg++) {
      const parClasse = ligne.classes.map((c) => {
        const cotes = coteClasse(ligne, c.id);
        const detail = {};
        cotes.forEach((ct) => { const q = quota(dep, dateIso, c.id, ct); const o = occupe(dep, ligne, dateIso, c.id, ct, seg, actifs); detail[ct] = { quota: q, occupees: o, libres: Math.max(0, q - o) }; });
        return { classeId: c.id, classeNom: c.nom, cotes: detail };
      });
      troncons.push({ de: ordre[seg].nom, vers: ordre[seg + 1].nom, classes: parClasse });
    }
    return { departId, date: dateIso, ligne: ligne.nom, heure: dep.heure, troncons };
  }

  function getTableauDeBord(opts) {
    if (!state) return null;
    expirerReservations();
    const auj = aujourdhuiISO();
    const rs = state.reservations;
    const confirmees = rs.filter((r) => r.statut === "Confirmé" || r.statut === "Embarqué");
    const aPayer = rs.filter((r) => r.statut === "À payer");
    const aVenir = confirmees.filter((r) => (r.retour ? r.retour.date : r.aller.date) >= auj);
    const prochains = [];
    const horizon = 7;
    for (let i = 0; i < horizon; i++) {
      const jour = dt.ajouterJours(auj, i);
      state.departs.forEach((dep) => {
        const ligne = ligneParId(dep.ligneId);
        if (!ligne || !circule(dep, jour)) return;
        const ordre = ordreArrets(ligne, dep.sens);
        let vendus = 0, total = 0;
        ligne.classes.forEach((c) => coteClasse(ligne, c.id).forEach((ct) => {
          const q = quota(dep, jour, c.id, ct); total += q;
          let maxOcc = 0;
          for (let seg = 0; seg < ordre.length - 1; seg++) maxOcc = Math.max(maxOcc, occupe(dep, ligne, jour, c.id, ct, seg, actives()));
          vendus += Math.min(q, maxOcc);
        }));
        prochains.push({ departId: dep.id, date: jour, ligne: ligne.nom, sens: dep.sens, trajet: ordre[0].nom + " → " + ordre[ordre.length - 1].nom, heure: heureNorm(dep.heure), vendus, quota: total });
      });
    }
    prochains.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.heure < b.heure ? -1 : 1);
    return {
      type: "transport",
      aPayer: aPayer.length,
      confirmees: aVenir.length,
      voyageursAVenir: aVenir.reduce((s, r) => s + r.nb, 0),
      chiffreAffairesConfirme: confirmees.reduce((s, r) => s + (r.total || 0), 0),
      montantEnAttente: aPayer.reduce((s, r) => s + (r.total || 0), 0),
      prochainsDeparts: prochains.slice(0, 12),
      reservationsAPayer: aPayer.sort((a, b) => a.expireLe < b.expireLe ? -1 : 1).slice(0, 10).map(vueReservation),
      cniChiffreeActive: !!process.env.ENCRYPTION_KEY,
      conversationsEnAttente: sh.listerConversationsEnAttente(conversationsHumain).length,
      commandesPeriode: rs.length, alertesStock: 0, ruptures: 0
    };
  }

  // ---------------- Simulateur ----------------
  function handleMessageSimulateur(text, opts) { return { reponse: handleMessage(PHONE_SIMULATEUR, text, opts), trace: null }; }
  function resetSimulateur() {
    delete sessions[PHONE_SIMULATEUR];
    delete conversationsHumain[PHONE_SIMULATEUR];
    delete humanHintDonne[PHONE_SIMULATEUR];
    if (state) {
      const avant = state.reservations.length;
      state.reservations = state.reservations.filter((r) => r.fromWhatsapp !== PHONE_SIMULATEUR);
      if (state.reservations.length !== avant) saveState();
    }
  }

  return {
    type: "transport",
    init,
    balayerSessions: () => persistance.balayer(),
    handleMessage,
    getEtatSession,
    nbBilletsAVenir,
    detailBilletsAVenir,
    definirLangueSession,
    reponseDeReprise,
    estEnPauseHumain,
    langueDeSession,
    getConversationsEnAttente,
    repondreConversationHumain,
    getLignes,
    updateLignes,
    genererTarifs,
    getDeparts,
    updateDeparts,
    getSettings,
    updateSettings,
    chargerExemple,
    getReservations,
    getReservationParId,
    updateReservationStatut,
    texteBillet,
    envoyerBillet,
    getManifeste,
    getOccupation,
    getTableauDeBord,
    handleMessageSimulateur,
    resetSimulateur,
    aujourdhuiISO
  };
}

module.exports = createTransportEngine;
module.exports.calculerTarifs = calculerTarifs;
module.exports.donneesExemple = donneesExemple;
