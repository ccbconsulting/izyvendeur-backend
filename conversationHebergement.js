// IzyVendeur - Moteur de conversation « hebergement » (Etape 65) : reservation de chambres par WhatsApp.
//
// Un marchand « hebergement » (residence hoteliere, hotel, auberge, maison d'hotes) vend des NUITS dans des
// chambres. C'est une ressource a capacite limitee reservee sur une PERIODE : chaque type de chambre a un nombre
// de chambres (`nombre`), un tarif par nuit et une capacite en personnes ; un sejour occupe un type de chambre
// pour chacune de ses nuits (arrivee incluse, depart exclu). Meme schema de dialogue que le moteur « service »
// (chaleur, alternatives en cas d'indisponibilite, recapitulatif, confirmation) et memes regles de statut :
//   - le client qui recapitule cree un sejour « Nouvelle » qui NE BLOQUE RIEN (il reste visible pour la relance) ;
//   - son « oui » le passe a « Confirme » (seul statut, avec « Arrive », qui occupe une chambre), apres une
//     revérification de la disponibilite (un autre client a pu confirmer entre-temps) ;
//   - annulation / report en libre-service, avec un delai limite optionnel (settings.delaiAnnulationHeures).
//
// Les dates sont des JOURS CALENDAIRES « AAAA-MM-JJ » (voir datesSejour.js) ; le fuseau du marchand ne sert qu'a
// savoir quel jour on est aujourd'hui et a calculer l'heure d'arrivee. Exporte une factory comme les deux autres
// moteurs : createHebergementEngine(merchantKey, options).

const db = require("./db");
const sessionsPersistantes = require("./sessionsPersistantes");
const sh = require("./shared");
const dt = require("./datesSejour");
const { formatFcfa, parseAffirmative, parseNegative, parseWantsSomethingElse } = sh;

const STATUTS_BLOQUANTS = ["Confirmé", "Arrivé"];   // occupent une chambre
const STATUTS_ACTIFS = ["Nouvelle", "Confirmé"];    // peuvent etre annules / reportes par le client
const STATUTS_VALIDES = ["Nouvelle", "Confirmé", "Arrivé", "Parti", "Absent", "Annulé"];
const PHONE_SIMULATEUR = "SIMULATEUR";
const MAX_NOUVELLES_PAR_TELEPHONE = 3;
const FENETRE_NOUVELLES_MS = 2 * 60 * 60 * 1000;
const NUITS_MAX_DEFAUT = 30;
const AVANCE_MAX_JOURS_DEFAUT = 365;
const STOPWORDS_CHAMBRE = ["chambre", "chambres", "room", "rooms", "de", "du", "des", "la", "le", "les", "en", "a", "au", "aux", "et", "un", "une", "pour", "avec", "and", "the", "with", "for", "of", "type"];

const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const JOURS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const DEFAUT_CONFIRMATION_FR = "Merci pour votre réservation, nous avons hâte de vous accueillir !";
const DEFAUT_CONFIRMATION_EN = "Thank you for your booking, we look forward to welcoming you!";

function seedState() {
  return {
    chambres: [
      { id: "c1", nom: "Chambre Standard", nombre: 5, prix: 25000, capacite: 2, description: "" },
      { id: "c2", nom: "Suite", nombre: 2, prix: 60000, capacite: 4, description: "" }
    ],
    sejours: [],
    nextId: 1,
    settings: reglagesParDefaut()
  };
}
function seedStateVide() { const e = seedState(); e.chambres = []; return e; }
function reglagesParDefaut() {
  return {
    heureArrivee: "14:00",
    heureDepart: "12:00",
    autoConfirmMessage: DEFAUT_CONFIRMATION_FR,
    autoConfirmMessageEn: "",
    notePaiement: "Règlement sur place, à votre arrivée.",
    notePaiementEn: "Payment on site, on arrival.",
    delaiAnnulationHeures: 0, // 0 = pas de delai : le client peut annuler / reporter jusqu'a l'arrivee
    modeDelaiDepasse: "refuser", // Etape 67 : "refuser" (renvoi vers un conseiller) ou "accepter" (annulation marquee « tardive »)
    listesDatesHeures: true, // Etape 68 : listes deroulantes d'arrivees puis de nuits proposees au client (case a cocher)
    nuitsMax: NUITS_MAX_DEFAUT,
    avanceMaxJours: AVANCE_MAX_JOURS_DEFAUT,
    fuseau: sh.FUSEAU_PAR_DEFAUT
  };
}

function normaliser(t) { return dt.normaliser(t); }

function createHebergementEngine(merchantKey, options) {
  let state = null;
  const sessions = {};
  const conversationsHumain = {};
  const humanHintDonne = {};
  const envoyer = (options && options.envoyer) || (async () => {});
  const notifierMarchand = (options && options.notifierMarchand) || (async () => {});
  const nomMarchandOption = (options && options.nomMarchand) || (() => "");
  const journaliserOption = (options && options.journaliser) || (async () => {});
  const cleEtat = (options && options.cleEtat) || merchantKey;

  // Etape 72 : sauvegarde des sessions de conversation (voir sessionsPersistantes.js). Une reservation « Nouvelle » qui
  // attend le « oui » du client reste en attente jusqu'a la date du sejour ; toute autre saisie intermediaire est
  // abandonnee apres 24 h sans message ; la langue choisie est gardee 90 jours.
  const persistance = sessionsPersistantes.creer({
    cle: cleEtat, sessions, conversationsHumain, ignorer: [PHONE_SIMULATEUR],
    regle: (s, age) => {
      const J = sessionsPersistantes.JOUR_MS;
      if (age > sessionsPersistantes.DUREE_MAX_JOURS * J) return null;
      if (age <= J) return s;
      if (s.stage === "awaiting_confirmation" && s.pendingSejourId && state) {
        const x = (state.sejours || []).find((y) => y.id === s.pendingSejourId);
        if (x && x.statut === "Nouvelle" && x.depart > aujourdhuiISO()) return s;
      }
      const neuve = freshSession(s); neuve.fromPhone = s.fromPhone;
      return neuve;
    }
  });
  let ignorerSejourId = null; // sejour en cours de report : ne bloque pas sa propre place

  function journaliser(telephone, de, texte) {
    if (!telephone || telephone === PHONE_SIMULATEUR) return;
    journaliserOption(telephone, de, texte).catch((erreur) => console.error("[" + merchantKey + "] Echec de journalisation de la conversation :", erreur));
  }

  async function init() {
    state = await db.initMerchantState(cleEtat, options && options.sansDonneesDemo ? seedStateVide : seedState);
    if (!Array.isArray(state.chambres)) state.chambres = [];
    if (!Array.isArray(state.sejours)) state.sejours = [];
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
  function aujourdhuiParties(maintenant) {
    const p = sh.partiesFuseau(maintenant || new Date(), fz());
    return { annee: p.annee, mois: p.mois, jour: p.jour };
  }
  function aujourdhuiISO(maintenant) { const p = aujourdhuiParties(maintenant); return dt.iso(p.annee, p.mois, p.jour); }
  function nomJour(dateIso, langue) { const i = dt.jourSemaineDe(dateIso); return langue === "en" ? JOURS_EN[i] : JOURS_FR[i]; }
  function formatJour(dateIso, session) {
    const en = sh.langueSession(session) === "en";
    const p = dateIso.split("-").map(Number);
    return en ? nomJour(dateIso, "en") + " " + p[2] + " " + MOIS_EN[p[1] - 1] : nomJour(dateIso, "fr") + " " + (p[2] === 1 ? "1er" : p[2]) + " " + MOIS_FR[p[1] - 1];
  }
  function formatCourt(dateIso, session) {
    const en = sh.langueSession(session) === "en";
    const p = dateIso.split("-").map(Number);
    return en ? nomJour(dateIso, "en").slice(0, 3) + " " + p[2] + " " + MOIS_EN[p[1] - 1].slice(0, 3)
      : nomJour(dateIso, "fr").slice(0, 3) + ". " + p[2] + " " + MOIS_FR[p[1] - 1].slice(0, 4).replace(/\.?$/, ".");
  }
  function formatCourtNum(dateIso) { const p = dateIso.split("-").map(Number); return p[2] + "/" + (p[1] < 10 ? "0" : "") + p[1]; }
  function libelleNuits(n, session) { return sh.t(session, n + (n > 1 ? " nuits" : " nuit"), n + (n > 1 ? " nights" : " night")); }
  function libellePersonnes(n, session) { return sh.t(session, n + (n > 1 ? " personnes" : " personne"), n + (n > 1 ? " people" : " person")); }
  function heureArrivee() { return reg().heureArrivee || "14:00"; }
  function heureDepart() { return reg().heureDepart || "12:00"; }
  function instantArrivee(sejour) {
    const p = sejour.arrivee.split("-").map(Number);
    const h = String(heureArrivee()).split(":").map(Number);
    return sh.dateDepuisPartiesFuseau(p[0], p[1], p[2], h[0] || 0, h[1] || 0, fz());
  }
  function refSejour(s) { return "SEJ-" + String(s.id).padStart(4, "0"); }

  // ---------------- Chambres, disponibilite ----------------
  function chambreParId(id) { return state.chambres.filter((c) => c.id === id)[0] || null; }
  function nombreChambres(c) { const n = parseInt(c && c.nombre, 10); return Number.isFinite(n) && n > 0 ? n : 0; }
  function capaciteChambre(c) { const n = parseInt(c && c.capacite, 10); return Number.isFinite(n) && n > 0 ? n : 2; }
  function prixNuit(c) { const n = parseInt(c && c.prix, 10); return Number.isFinite(n) && n >= 0 ? n : 0; }

  function sejoursQuiBloquent(pourSimulateur) {
    return state.sejours.filter((s) => STATUTS_BLOQUANTS.indexOf(s.statut) !== -1 && s.id !== ignorerSejourId && (s.source !== "simulateur" || pourSimulateur));
  }
  // Nombre de chambres de ce type occupees la nuit `nuitIso`.
  function occupees(chambreId, nuitIso, pourSimulateur, bloquants) {
    const liste = bloquants || sejoursQuiBloquent(pourSimulateur);
    let n = 0;
    for (let i = 0; i < liste.length; i++) {
      const s = liste[i];
      if (s.chambreId === chambreId && s.arrivee <= nuitIso && nuitIso < s.depart) n++;
    }
    return n;
  }
  // Une chambre de ce type est-elle libre pour TOUTES les nuits [arrivee, depart[ ?
  function disponible(chambre, arrivee, depart, pourSimulateur) {
    if (!chambre || nombreChambres(chambre) < 1) return false;
    const bloquants = sejoursQuiBloquent(pourSimulateur);
    const total = nombreChambres(chambre);
    for (let d = arrivee; d < depart; d = dt.ajouterJours(d, 1)) {
      if (occupees(chambre.id, d, pourSimulateur, bloquants) >= total) return false;
    }
    return true;
  }

  function matchChambre(text) {
    const t = normaliser(text);
    if (!t) return null;
    const mots = new Set(t.split(/[^a-z0-9]+/).filter(Boolean));
    const complets = [];
    state.chambres.forEach((c) => {
      const nomN = normaliser(c.nom);
      if (!nomN) return;
      if (t.indexOf(nomN) !== -1) { complets.push({ c, force: 100 + nomN.length }); return; }
      const cles = nomN.split(/[^a-z0-9]+/).filter((m) => m && STOPWORDS_CHAMBRE.indexOf(m) === -1);
      if (!cles.length) return;
      if (cles.every((m) => mots.has(m))) complets.push({ c, force: cles.length });
    });
    if (!complets.length) return null;
    complets.sort((a, b) => b.force - a.force);
    if (complets.length > 1 && complets[0].force === complets[1].force) return null;
    return complets[0].c;
  }

  // ---------------- Sessions ----------------
  function freshSession(precedente) {
    return {
      langue: precedente ? precedente.langue : null,
      stage: "idle",
      chambreId: null, arrivee: null, depart: null, nuits: null, personnes: null, clientNom: null,
      pendingSejourId: null, proposals: null,
      reportSejourId: null, intentionSejour: null, choixIds: null,
      confirmerAnnulation: false, annulationSejourId: null,
      pretPourChoix: false
    };
  }
  function resetSession(session) { Object.assign(session, freshSession(session)); return session; }
  function getSession(fromPhone) {
    if (!sessions[fromPhone]) sessions[fromPhone] = freshSession();
    sessions[fromPhone].fromPhone = fromPhone;
    return sessions[fromPhone];
  }

  // ---------------- Messages ----------------
  function listeChambresTexte(session) {
    return state.chambres.map((c) => "• " + c.nom + " — " + sh.t(session, "à partir de ", "from ") + formatFcfa(prixNuit(c)) + sh.t(session, " / nuit", " / night") + " (" + sh.t(session, "jusqu'à ", "up to ") + libellePersonnes(capaciteChambre(c), session) + ")").join("\n");
  }
  // Etape 70 : message d'accueil PERSONNALISE du marchand (Parametres > chambres), dans la langue du client (l'autre langue sert
  // de repli). Vide par defaut : l'accueil standard « Bienvenue chez <nom> » est alors inchange.
  function accueilPerso(session) {
    const r = reg();
    const fr = String(r.messageAccueilSupplementaire || "").trim(), en = String(r.messageAccueilSupplementaireEn || "").trim();
    return sh.langueSession(session) === "en" ? (en || fr) : (fr || en);
  }
  function messageChoixChambre(session, introFr, introEn) {
    session.accueilPersoAffiche = false;
    if (!state.chambres.length) {
      return sh.t(session, "Nous n'avons pas encore de chambre à vous proposer ici. Un conseiller peut vous aider : écrivez « conseiller ».", "We have no rooms to offer here yet. An advisor can help you: type \"advisor\".");
    }
    session.pretPourChoix = true;
    return sh.t(session, introFr, introEn) + "\n" + listeChambresTexte(session);
  }
  function messageDemandeDates(session, chambre) {
    const delaiExemple = sh.t(session, "ex : du 12 au 15 novembre, ou vendredi pour 2 nuits", "e.g. from 12 to 15 November, or Friday for 2 nights");
    return sh.t(session,
      (chambre ? ouverture(session, true) + " " + chambre.nom + " (" + formatFcfa(prixNuit(chambre)) + " / nuit). " : "") + "Quelles sont vos dates de séjour ? (" + delaiExemple + ")",
      (chambre ? ouverture(session, false) + " " + chambre.nom + " (" + formatFcfa(prixNuit(chambre)) + " / night). " : "") + "What are your stay dates? (" + delaiExemple + ")");
  }
  const OUV_FR = ["Excellent choix !", "Très bon choix !", "Parfait !", "Belle sélection !"];
  const OUV_EN = ["Excellent choice!", "Great choice!", "Perfect!", "Lovely pick!"];
  function ouverture(session, fr) { return sh.piocheParmi(fr ? OUV_FR : OUV_EN); }

  // ---------------- Lecture du message : met a jour la session sans rien deviner ----------------
  // Retourne true si au moins un element (chambre, dates, personnes) a ete reconnu dans ce message.
  function absorber(session, text, opts) {
    let reconnu = false;
    const c = matchChambre(text);
    if (c && c.id !== session.chambreId) { session.chambreId = c.id; reconnu = true; if (!(opts && opts.garderDates)) { /* on garde les dates deja donnees */ } }
    else if (c) reconnu = true;
    const d = dt.lireDatesSejour(text, aujourdhuiParties());
    if (d.arrivee) { session.arrivee = d.arrivee; session.depart = d.depart || null; session.nuits = d.nuits || null; reconnu = true; }
    else if (d.nuits) {
      session.nuits = d.nuits;
      if (session.arrivee) session.depart = dt.ajouterJours(session.arrivee, d.nuits);
      reconnu = true;
    }
    if (opts && opts.lirePersonnes) {
      const n = dt.lirePersonnes(text);
      if (n) { session.personnes = n; reconnu = true; }
    } else if (/\b(personne|personnes|adulte|adultes|people|persons?|guests?)\b/.test(normaliser(text))) {
      const n = dt.lirePersonnes(text);
      if (n) { session.personnes = n; reconnu = true; }
    }
    return reconnu;
  }

  // Verifie la coherence des dates ; renvoie un message d'erreur (dans la langue du client) ou null.
  function problemeDates(session) {
    const auj = aujourdhuiISO();
    if (session.arrivee < auj) return sh.t(session, "Cette date d'arrivée est déjà passée. Quelles sont vos dates de séjour ?", "That arrival date has already passed. What are your stay dates?");
    const max = parseInt(reg().avanceMaxJours, 10) || AVANCE_MAX_JOURS_DEFAUT;
    if (dt.nuitsEntre(auj, session.arrivee) > max) return sh.t(session, "Nous ne prenons pas de réservation aussi lointaine (" + max + " jours maximum à l'avance). Quelles autres dates ?", "We can't take bookings that far ahead (" + max + " days maximum). What other dates?");
    if (session.depart) {
      const n = dt.nuitsEntre(session.arrivee, session.depart);
      if (n < 1) return sh.t(session, "La date de départ doit être après l'arrivée. Quelles sont vos dates de séjour ?", "The departure date must be after the arrival. What are your stay dates?");
      const nm = parseInt(reg().nuitsMax, 10) || NUITS_MAX_DEFAUT;
      if (n > nm) return sh.t(session, "Pour un séjour de plus de " + nm + " nuits, merci de contacter un conseiller (écrivez « conseiller »).", "For stays longer than " + nm + " nights, please contact an advisor (type \"advisor\").");
    }
    return null;
  }

  // ---------------- Coeur du dialogue : demande ce qui manque, puis verifie et recapitule ----------------
  function avancer(session) {
    if (!session.chambreId || !chambreParId(session.chambreId)) {
      resetEtapeChambre(session);
      return messageChoixChambre(session, "Bonjour ! Quelle chambre vous intéresse ?", "Hello! Which room are you interested in?");
    }
    const chambre = chambreParId(session.chambreId);
    if (!session.arrivee) {
      session.stage = "awaiting_dates";
      return messageDemandeDates(session, chambre);
    }
    if (session.arrivee && !session.depart && !session.nuits) {
      session.stage = "awaiting_dates";
      return sh.t(session, "Arrivée le " + formatJour(session.arrivee, session) + ". Pour combien de nuits ? (ou indiquez votre date de départ)", "Arrival on " + formatJour(session.arrivee, session) + ". For how many nights? (or tell me your departure date)");
    }
    if (!session.depart && session.nuits) session.depart = dt.ajouterJours(session.arrivee, session.nuits);
    session.nuits = dt.nuitsEntre(session.arrivee, session.depart);
    const probleme = problemeDates(session);
    if (probleme) { session.arrivee = null; session.depart = null; session.nuits = null; session.stage = "awaiting_dates"; return probleme; }
    if (!session.personnes) {
      session.stage = "awaiting_personnes";
      return sh.t(session, "Combien de personnes séjourneront ?", "How many people will be staying?");
    }
    if (session.personnes > capaciteChambre(chambre)) {
      return proposerAlternatives(session, sh.t(session,
        chambre.nom + " accueille " + libellePersonnes(capaciteChambre(chambre), session) + " au maximum.",
        chambre.nom + " sleeps " + libellePersonnes(capaciteChambre(chambre), session) + " at most."));
    }
    const pourSim = session.fromPhone === PHONE_SIMULATEUR;
    if (!disponible(chambre, session.arrivee, session.depart, pourSim)) {
      return proposerAlternatives(session, sh.t(session,
        chambre.nom + " n'est pas disponible du " + formatCourt(session.arrivee, session) + " au " + formatCourt(session.depart, session) + ".",
        chambre.nom + " is not available from " + formatCourt(session.arrivee, session) + " to " + formatCourt(session.depart, session) + "."));
    }
    if (!session.clientNom) {
      session.stage = "awaiting_client_name";
      return sh.t(session,
        "Bonne nouvelle, " + chambre.nom + " est disponible du " + formatJour(session.arrivee, session) + " au " + formatJour(session.depart, session) + " (" + libelleNuits(session.nuits, session) + "). À quel nom dois-je noter la réservation ?",
        "Good news, " + chambre.nom + " is available from " + formatJour(session.arrivee, session) + " to " + formatJour(session.depart, session) + " (" + libelleNuits(session.nuits, session) + "). What name should I put the booking under?");
    }
    return finaliserRecap(session);
  }

  function resetEtapeChambre(session) {
    session.stage = "idle"; session.chambreId = null; session.pretPourChoix = false;
  }

  // ---------------- Alternatives ----------------
  function chercherAlternatives(session) {
    const pourSim = session.fromPhone === PHONE_SIMULATEUR;
    const auj = aujourdhuiISO();
    const nuits = session.nuits || dt.nuitsEntre(session.arrivee, session.depart);
    const parChambre = [], parDates = [];
    state.chambres.forEach((c) => {
      if (c.id === session.chambreId) return;
      if (session.personnes && session.personnes > capaciteChambre(c)) return;
      if (disponible(c, session.arrivee, session.depart, pourSim)) parChambre.push({ chambreId: c.id, arrivee: session.arrivee, depart: session.depart, type: "chambre" });
    });
    parChambre.sort((a, b) => prixNuit(chambreParId(a.chambreId)) - prixNuit(chambreParId(b.chambreId)));
    const courante = chambreParId(session.chambreId);
    if (courante && (!session.personnes || session.personnes <= capaciteChambre(courante))) {
      [1, -1, 2, -2, 3, -3, 4, 5, 6, 7, -4, -5, 8, 9, 10, 14].forEach((delta) => {
        if (parDates.length >= 2) return;
        const a2 = dt.ajouterJours(session.arrivee, delta);
        if (a2 < auj) return;
        const d2 = dt.ajouterJours(a2, nuits);
        if (disponible(courante, a2, d2, pourSim)) parDates.push({ chambreId: courante.id, arrivee: a2, depart: d2, type: "dates" });
      });
    }
    const resultat = [];
    const sources = [parChambre.slice(), parDates.slice()];
    while (resultat.length < 3 && (sources[0].length || sources[1].length)) {
      if (sources[0].length) resultat.push(sources[0].shift());
      if (resultat.length < 3 && sources[1].length) resultat.push(sources[1].shift());
    }
    return resultat;
  }

  function libelleProposition(p, session) {
    const c = chambreParId(p.chambreId);
    return p.type === "chambre"
      ? c.nom + " — " + formatFcfa(prixNuit(c)) + sh.t(session, " / nuit (mêmes dates)", " / night (same dates)")
      : c.nom + " — " + sh.t(session, "du ", "from ") + formatCourt(p.arrivee, session) + sh.t(session, " au ", " to ") + formatCourt(p.depart, session) + " (" + libelleNuits(dt.nuitsEntre(p.arrivee, p.depart), session) + ")";
  }
  function libelleCourtProposition(p, session) {
    const c = chambreParId(p.chambreId);
    return p.type === "chambre" ? c.nom : formatCourtNum(p.arrivee) + " → " + formatCourtNum(p.depart);
  }

  function proposerAlternatives(session, raison) {
    const alts = chercherAlternatives(session);
    if (!alts.length) {
      session.arrivee = null; session.depart = null; session.nuits = null; session.proposals = null;
      session.stage = "awaiting_dates";
      return raison + " " + sh.t(session,
        "Je ne trouve rien de proche pour ces dates. Souhaitez-vous essayer d'autres dates ? Sinon, écrivez « conseiller » et notre équipe vous aidera.",
        "I can't find anything close to these dates. Would you like to try other dates? Otherwise type \"advisor\" and our team will help.");
    }
    session.proposals = alts;
    session.stage = "awaiting_slot_choice";
    const lignes = alts.map((a, i) => (i + 1) + ". " + libelleProposition(a, session)).join("\n");
    return raison + " " + sh.t(session,
      "Voici ce que je peux vous proposer :\n" + lignes + "\n\nQuelle option vous convient ? (répondez par son numéro, ou indiquez d'autres dates)",
      "Here is what I can offer:\n" + lignes + "\n\nWhich option suits you? (reply with its number, or give me other dates)");
  }

  // ---------------- Recapitulatif et creation du sejour provisoire ----------------
  function creerOuMettreAJourProvisoire(session) {
    const chambre = chambreParId(session.chambreId);
    const nuits = dt.nuitsEntre(session.arrivee, session.depart);
    const champs = {
      chambreId: chambre.id, chambre: chambre.nom, arrivee: session.arrivee, depart: session.depart, nuits,
      personnes: session.personnes, prixNuit: prixNuit(chambre), total: prixNuit(chambre) * nuits,
      clientNom: session.clientNom, telephone: session.fromPhone === PHONE_SIMULATEUR ? "SIMULATEUR" : session.fromPhone
    };
    let s = session.pendingSejourId ? state.sejours.filter((x) => x.id === session.pendingSejourId)[0] : null;
    if (s && s.statut === "Nouvelle") { Object.assign(s, champs); saveState(); return s; }
    // Garde-fou anti-inondation : trop de sejours « Nouvelle » recents pour ce numero
    const maintenant = Date.now();
    const recentes = state.sejours.filter((x) => x.statut === "Nouvelle" && x.fromWhatsapp === session.fromPhone && maintenant - new Date(x.createdAtISO).getTime() < FENETRE_NOUVELLES_MS);
    if (recentes.length >= MAX_NOUVELLES_PAR_TELEPHONE) return null;
    s = Object.assign({
      id: state.nextId++, statut: "Nouvelle", raisonAnnulation: null, createdAtISO: new Date().toISOString(),
      source: session.fromPhone === PHONE_SIMULATEUR ? "simulateur" : "whatsapp", fromWhatsapp: session.fromPhone,
      langue: sh.langueSession(session), remplaceId: session.reportSejourId || null
    }, champs);
    state.sejours.push(s);
    session.pendingSejourId = s.id;
    saveState();
    return s;
  }

  function finaliserRecap(session) {
    const s = creerOuMettreAJourProvisoire(session);
    if (!s) {
      resetSession(session);
      return sh.t(session, "Vous avez déjà plusieurs demandes en attente de confirmation. Pour aller plus vite, écrivez « conseiller » : notre équipe vous aidera.", "You already have several requests awaiting confirmation. To speed things up, type \"advisor\": our team will help.");
    }
    session.stage = "awaiting_confirmation";
    const en = sh.langueSession(session) === "en";
    const note = en ? (reg().notePaiementEn || reg().notePaiement) : (reg().notePaiement || reg().notePaiementEn);
    const lignes = en
      ? ["Summary of your booking:",
        "• Room: " + s.chambre,
        "• Arrival: " + formatJour(s.arrivee, session) + " (from " + heureArrivee() + ")",
        "• Departure: " + formatJour(s.depart, session) + " (before " + heureDepart() + ")",
        "• " + libelleNuits(s.nuits, session) + ", " + libellePersonnes(s.personnes, session),
        "• Total: " + formatFcfa(s.total) + (note ? " (" + note + ")" : ""),
        "• Name: " + s.clientNom,
        "",
        s.remplaceId ? "This replaces your current booking only once you confirm. Do you confirm? (yes / no)" : "Do you confirm this booking? (yes / no)"]
      : ["Récapitulatif de votre réservation :",
        "• Chambre : " + s.chambre,
        "• Arrivée : " + formatJour(s.arrivee, session) + " (à partir de " + heureArrivee() + ")",
        "• Départ : " + formatJour(s.depart, session) + " (avant " + heureDepart() + ")",
        "• " + libelleNuits(s.nuits, session) + ", " + libellePersonnes(s.personnes, session),
        "• Total : " + formatFcfa(s.total) + (note ? " (" + note + ")" : ""),
        "• Au nom de : " + s.clientNom,
        "",
        s.remplaceId ? "Elle ne remplacera votre réservation actuelle qu'une fois confirmée. Confirmez-vous ? (oui / non)" : "Confirmez-vous cette réservation ? (oui / non)"];
    return lignes.join("\n");
  }

  // Revérification juste avant de confirmer : retourne un message (conflit) ou null (tout est bon).
  function verifierAvantConfirmation(session, s) {
    const auj = aujourdhuiISO();
    const pourSim = s.source === "simulateur";
    const ancien = s.remplaceId ? sejourParId(s.remplaceId) : null;
    ignorerSejourId = ancien ? ancien.id : null;
    let libre;
    try { libre = s.arrivee >= auj && disponible(chambreParId(s.chambreId), s.arrivee, s.depart, pourSim); } finally { ignorerSejourId = null; }
    if (libre) return null;
    const passe = s.arrivee < auj;
    changerStatut(s, "Annulé", passe ? "Date dépassée avant la confirmation" : "Chambre prise par un autre client avant la confirmation");
    saveState();
    session.pendingSejourId = null;
    session.chambreId = s.chambreId; session.arrivee = passe ? null : s.arrivee; session.depart = passe ? null : s.depart; session.nuits = s.nuits; session.personnes = s.personnes;
    if (passe) { session.arrivee = null; session.depart = null; session.nuits = null; session.stage = "awaiting_dates"; return sh.t(session, "Cette date est déjà passée : quelles sont vos nouvelles dates de séjour ?", "That date has already passed: what are your new stay dates?"); }
    return proposerAlternatives(session, sh.t(session,
      "Désolé, entre-temps " + s.chambre + " a été réservée par un autre client pour ces dates.",
      "Sorry, in the meantime " + s.chambre + " was booked by another guest for those dates."));
  }

  function changerStatut(s, nouveau, raison) {
    s.statut = nouveau;
    if (nouveau === "Annulé") s.raisonAnnulation = raison || s.raisonAnnulation || null;
    if (!s.historique) s.historique = [];
    s.historique.push({ statut: nouveau, atISO: new Date().toISOString(), raison: raison || null });
  }
  function sejourParId(id) { return state.sejours.filter((s) => s.id === Number(id))[0] || null; }

  // ---------------- Confirmation ("oui") ----------------
  function confirmerSejour(session, s) {
    const conflit = verifierAvantConfirmation(session, s);
    if (conflit) return conflit;
    changerStatut(s, "Confirmé");
    const ancien = s.remplaceId ? sejourParId(s.remplaceId) : null;
    if (ancien && STATUTS_ACTIFS.indexOf(ancien.statut) !== -1) {
      const reportTardif = sejourHorsDelai(ancien); // avant le changement de statut
      changerStatut(ancien, "Annulé", (reportTardif ? "Reporté tardivement par le client via WhatsApp (moins de " + parseFloat(reg().delaiAnnulationHeures) + " h avant l'arrivée, remplacé par " : "Reporté par le client via WhatsApp (remplacé par ") + refSejour(s) + ")");
      if (reportTardif) ancien.annulationTardive = true;
      ancien.remplaceParId = s.id;
      saveState();
      alerterSejourModifie("reporte", ancien, s);
    } else {
      saveState();
      notifierMarchand("rdv_confirme", [
        refSejour(s),
        s.chambre + " (" + libelleNuits(s.nuits, null) + ", " + libellePersonnes(s.personnes, null) + ")",
        "du " + formatCourtNum(s.arrivee) + " au " + formatCourtNum(s.depart),
        formatFcfa(s.total), s.clientNom || "—", s.telephone || session.fromPhone || "—"
      ]).catch((erreur) => console.error("[" + merchantKey + "] Echec de la notification marchand (sejour confirme) :", erreur));
    }
    const en = sh.langueSession(session) === "en";
    const perso = en ? (reg().autoConfirmMessageEn || DEFAUT_CONFIRMATION_EN) : (reg().autoConfirmMessage || DEFAUT_CONFIRMATION_FR);
    const detail = en
      ? "Your booking " + refSejour(s) + " is confirmed ✅\n" + s.chambre + ", " + formatJour(s.arrivee, session) + " → " + formatJour(s.depart, session) + " (" + libelleNuits(s.nuits, session) + ").\nCheck-in from " + heureArrivee() + ", check-out before " + heureDepart() + ".\n"
      : "Votre réservation " + refSejour(s) + " est confirmée ✅\n" + s.chambre + ", " + formatJour(s.arrivee, session) + " → " + formatJour(s.depart, session) + " (" + libelleNuits(s.nuits, session) + ").\nArrivée à partir de " + heureArrivee() + ", départ avant " + heureDepart() + ".\n";
    resetSession(session);
    return detail + perso;
  }

  function alerterSejourModifie(action, ancien, nouveau) {
    const libelleAction = (action === "annule" ? "annulée" : "déplacée") + (ancien.annulationTardive ? " TARDIVEMENT" : "") + " par le client";
    notifierMarchand("rdv_modifie", [
      refSejour(ancien), ancien.chambre + " (" + libelleNuits(ancien.nuits, null) + ")", libelleAction,
      "du " + formatCourtNum(ancien.arrivee) + " au " + formatCourtNum(ancien.depart),
      nouveau ? "du " + formatCourtNum(nouveau.arrivee) + " au " + formatCourtNum(nouveau.depart) + " (" + refSejour(nouveau) + ")" : "—",
      ancien.clientNom || "—", ancien.telephone || "—"
    ]).catch((erreur) => console.error("[" + merchantKey + "] Echec de la notification marchand (sejour modifie) :", erreur));
  }

  // ---------------- Annulation / report en libre-service ----------------
  function sejoursAVenirDuClient(telephone) {
    const auj = aujourdhuiISO();
    return state.sejours.filter((s) => s.telephone === telephone && STATUTS_ACTIFS.indexOf(s.statut) !== -1 && s.depart > auj)
      .sort((a, b) => (a.arrivee < b.arrivee ? -1 : a.arrivee > b.arrivee ? 1 : a.id - b.id));
  }
  function nbSejoursAVenir(telephone) { return sejoursAVenirDuClient(telephone).length; }
  // Etape 72 : detail des sejours a venir d'un client (cinq au plus), affiche au-dessus des choix de l'ecran
  // « Ma reservation ». Chaine vide s'il n'y en a aucun.
  function detailSejoursAVenir(telephone) {
    if (!state || !telephone) return "";
    const s = sessions[telephone] || {};
    const liste = sejoursAVenirDuClient(telephone);
    if (!liste.length) return "";
    const lignes = liste.slice(0, 5).map((x) => {
      const details = [sh.t(s, "du ", "from ") + formatCourt(x.arrivee, s) + sh.t(s, " au ", " to ") + formatCourt(x.depart, s) + " (" + libelleNuits(x.nuits, s) + ")", libellePersonnes(x.personnes || 1, s)];
      if (x.total) details.push(formatFcfa(x.total));
      details.push(x.statut === "Confirmé" ? sh.t(s, "confirmée", "confirmed") : sh.t(s, "à confirmer", "to be confirmed"));
      return "• " + refSejour(x) + " — " + x.chambre + "\n   " + details.join(" · ");
    });
    const plusieurs = liste.length > 1;
    return sh.t(s, plusieurs ? "Vos réservations :" : "Votre réservation :", plusieurs ? "Your bookings:" : "Your booking:") + "\n" + lignes.join("\n") + (liste.length > 5 ? "\n…" : "");
  }

  function modeDelai() { return reg().modeDelaiDepasse === "accepter" ? "accepter" : "refuser"; }
  // Etape 67 : seul un sejour « Confirmé » est soumis au delai ; en mode « accepter », le client peut annuler /
  // reporter mais le sejour est marque « annulation tardive ».
  function sejourHorsDelai(s) {
    const h = parseFloat(reg().delaiAnnulationHeures);
    if (!(h > 0) || !s || s.statut !== "Confirmé") return false;
    return instantArrivee(s).getTime() - Date.now() < h * 3600000;
  }
  function delaiOk(s) { return !sejourHorsDelai(s) || modeDelai() === "accepter"; }
  function messageDelaiDepasse(session, s) {
    const h = parseFloat(reg().delaiAnnulationHeures);
    return sh.t(session,
      "Votre réservation " + refSejour(s) + " débute dans moins de " + h + " h : au-delà de ce délai, l'annulation ou le report ne se fait plus ici. Écrivez « conseiller » et notre équipe s'en occupe.",
      "Your booking " + refSejour(s) + " starts in less than " + h + " h: past that deadline, cancelling or rescheduling can no longer be done here. Type \"advisor\" and our team will take care of it.");
  }
  function resumeSejour(s, session) {
    return refSejour(s) + " (" + s.chambre + ", " + formatCourt(s.arrivee, session) + " → " + formatCourt(s.depart, session) + ")";
  }

  function gererAnnulationOuReport(session, intention, confirmer) {
    const liste = sejoursAVenirDuClient(session.fromPhone === PHONE_SIMULATEUR ? "SIMULATEUR" : session.fromPhone);
    if (!liste.length) {
      resetSession(session);
      return sh.t(session, "Je ne trouve aucune réservation à venir avec ce numéro. Si vous avez réservé avec un autre numéro, écrivez « conseiller ».", "I can't find any upcoming booking with this number. If you booked with another number, type \"advisor\".");
    }
    if (liste.length > 1) {
      session.stage = "awaiting_rdv_choice";
      session.choixIds = liste.map((s) => s.id);
      session.intentionSejour = intention;
      session.confirmerAnnulation = !!confirmer;
      const lignes = liste.map((s, i) => (i + 1) + ". " + resumeSejour(s, session)).join("\n");
      return sh.t(session,
        "Vous avez plusieurs réservations à venir :\n" + lignes + "\n\nLaquelle souhaitez-vous " + (intention === "annuler" ? "annuler" : "déplacer") + " ? (répondez par son numéro)",
        "You have several upcoming bookings:\n" + lignes + "\n\nWhich one would you like to " + (intention === "annuler" ? "cancel" : "move") + "? (reply with its number)");
    }
    if (intention === "annuler" && confirmer) return demanderConfirmationAnnulation(session, liste[0]);
    return appliquerIntention(session, intention, liste[0]);
  }

  function demanderConfirmationAnnulation(session, s) {
    if (!delaiOk(s)) { resetSession(session); return messageDelaiDepasse(session, s); }
    session.stage = "awaiting_annulation_confirm";
    session.annulationSejourId = s.id;
    return sh.t(session, "Confirmez-vous l'annulation de votre réservation " + resumeSejour(s, session) + " ?", "Do you confirm the cancellation of your booking " + resumeSejour(s, session) + "?");
  }

  function appliquerIntention(session, intention, s) {
    if (!delaiOk(s)) { resetSession(session); return messageDelaiDepasse(session, s); }
    if (intention === "annuler") {
      const tardif = sejourHorsDelai(s);
      changerStatut(s, "Annulé", tardif ? "Annulé tardivement par le client via WhatsApp (moins de " + parseFloat(reg().delaiAnnulationHeures) + " h avant l'arrivée)" : "Annulé par le client via WhatsApp");
      if (tardif) s.annulationTardive = true;
      saveState();
      alerterSejourModifie("annule", s, null);
      resetSession(session);
      return sh.t(session, "Votre réservation " + resumeSejour(s, session) + " est annulée. Vous pouvez réserver de nouveau quand vous le souhaitez.", "Your booking " + resumeSejour(s, session) + " is cancelled. You can book again whenever you like.");
    }
    // report : on garde l'ancien sejour tant que le nouveau n'est pas confirme
    resetSession(session);
    session.reportSejourId = s.id;
    session.chambreId = s.chambreId; session.personnes = s.personnes; session.clientNom = s.clientNom;
    session.stage = "awaiting_dates";
    return sh.t(session,
      "D'accord, votre réservation " + resumeSejour(s, session) + " reste en place tant que la nouvelle n'est pas confirmée. Quelles sont vos nouvelles dates ? (ex : du 12 au 15 novembre)",
      "Alright, your booking " + resumeSejour(s, session) + " stays in place until the new one is confirmed. What are your new dates? (e.g. from 12 to 15 November)");
  }

  function abandonnerReport(session) {
    const ancien = session.reportSejourId ? sejourParId(session.reportSejourId) : null;
    const provisoire = session.pendingSejourId ? sejourParId(session.pendingSejourId) : null;
    if (provisoire && provisoire.statut === "Nouvelle") { changerStatut(provisoire, "Annulé", "Report abandonné par le client"); saveState(); }
    resetSession(session);
    return ancien
      ? sh.t(session, "Très bien, votre réservation " + resumeSejour(ancien, session) + " reste inchangée.", "Alright, your booking " + resumeSejour(ancien, session) + " stays unchanged.")
      : sh.t(session, "Très bien, rien n'est modifié.", "Alright, nothing has changed.");
  }

  // ---------------- Traitement d'un message selon l'etape ----------------
  function processMessage(session, text) {
    session.pretPourChoix = false;
    const brut = String(text || "");

    if (session.stage === "awaiting_rdv_choice") {
      const ids = session.choixIds || [];
      const num = brut.trim().match(/^\D{0,12}(\d{1,2})\D{0,3}$/);
      const ref = brut.match(/sej[\s-]*0*(\d+)/i);
      let choisi = null;
      if (ref && ids.indexOf(Number(ref[1])) !== -1) choisi = Number(ref[1]);
      else if (num && Number(num[1]) >= 1 && Number(num[1]) <= ids.length) choisi = ids[Number(num[1]) - 1];
      const s = choisi !== null ? sejourParId(choisi) : null;
      if (s) {
        const intention = session.intentionSejour, avec = session.confirmerAnnulation;
        session.choixIds = null; session.intentionSejour = null; session.confirmerAnnulation = false;
        if (intention === "annuler" && avec) return demanderConfirmationAnnulation(session, s);
        return appliquerIntention(session, intention, s);
      }
      if (parseNegative(brut) || parseWantsSomethingElse(brut)) {
        resetSession(session);
        return sh.t(session, "Très bien, vos réservations restent inchangées.", "Alright, your bookings stay as they are.");
      }
      return sh.t(session, "Je n'ai pas compris. Répondez par le numéro de la réservation concernée (1 à " + ids.length + "), ou « non » pour ne rien changer.", "I didn't understand. Reply with the number of the booking (1 to " + ids.length + "), or \"no\" to change nothing.");
    }

    if (session.stage === "awaiting_annulation_confirm") {
      const s = session.annulationSejourId ? sejourParId(session.annulationSejourId) : null;
      if (!s || STATUTS_ACTIFS.indexOf(s.statut) === -1) { resetSession(session); return sh.t(session, "Cette réservation n'est plus à venir : rien à annuler.", "That booking is no longer upcoming: nothing to cancel."); }
      if (parseAffirmative(brut)) return appliquerIntention(session, "annuler", s);
      if (parseNegative(brut) || parseWantsSomethingElse(brut)) { resetSession(session); return sh.t(session, "Très bien, votre réservation " + resumeSejour(s, session) + " est conservée.", "Alright, your booking " + resumeSejour(s, session) + " is kept."); }
      return sh.t(session, "Je n'ai pas compris. Souhaitez-vous annuler votre réservation " + refSejour(s) + " ? Répondez par oui ou non.", "I didn't understand. Do you want to cancel your booking " + refSejour(s) + "? Please reply yes or no.");
    }

    if (session.stage === "awaiting_confirmation") {
      const s = session.pendingSejourId ? sejourParId(session.pendingSejourId) : null;
      if (s && parseAffirmative(brut)) return confirmerSejour(session, s);
      if (s && (parseNegative(brut) || parseWantsSomethingElse(brut))) {
        if (s.remplaceId) return abandonnerReport(session);
        resetSession(session);
        return sh.t(session, "Très bien, cette réservation n'est pas confirmée. Vous pouvez réserver quand vous voulez ; notre équipe pourra aussi vous recontacter.", "Alright, that booking is not confirmed. You can book whenever you like; our team may also get back to you.");
      }
      if (s) {
        // peut-etre de nouvelles dates ou une autre chambre
        const avant = JSON.stringify([session.chambreId, session.arrivee, session.depart]);
        if (absorber(session, brut) && JSON.stringify([session.chambreId, session.arrivee, session.depart]) !== avant) return avancer(session);
        return sh.t(session, "Je n'ai pas bien compris. Confirmez-vous la réservation " + refSejour(s) + " ? Répondez simplement par oui ou non — ou donnez-moi d'autres dates.", "I didn't quite get that. Do you confirm booking " + refSejour(s) + "? Simply reply yes or no — or give me other dates.");
      }
      resetSession(session);
      return sh.t(session, "Très bien, rien n'est enregistré.", "Alright, nothing is recorded.");
    }

    if (session.stage === "awaiting_client_name") {
      const nom = brut.trim().slice(0, 80);
      if (!nom) return sh.t(session, "Merci d'indiquer le nom à noter pour cette réservation.", "Please tell me the name to put this booking under.");
      if (parseWantsSomethingElse(brut) || parseNegative(brut)) {
        if (session.reportSejourId) return abandonnerReport(session);
        resetSession(session);
        return messageChoixChambre(session, "Pas de souci ! Quelle chambre vous intéresse ?", "No problem! Which room are you interested in?");
      }
      session.clientNom = nom;
      return avancer(session);
    }

    if (session.stage === "awaiting_personnes") {
      const n = dt.lirePersonnes(brut);
      if (n && n >= 1 && n <= 20) { session.personnes = n; return avancer(session); }
      if (parseNegative(brut) || parseWantsSomethingElse(brut)) {
        if (session.reportSejourId) return abandonnerReport(session);
        resetSession(session);
        return messageChoixChambre(session, "Pas de souci ! Quelle chambre vous intéresse ?", "No problem! Which room are you interested in?");
      }
      absorber(session, brut);
      if (session.personnes) return avancer(session);
      return sh.t(session, "Je n'ai pas compris. Indiquez simplement le nombre de personnes (ex : 2).", "I didn't understand. Just tell me the number of people (e.g. 2).");
    }

    if (session.stage === "awaiting_slot_choice") {
      const props = session.proposals || [];
      const num = brut.trim().match(/^\D{0,12}(\d{1,2})\D{0,3}$/);
      let choix = null;
      if (num && Number(num[1]) >= 1 && Number(num[1]) <= props.length) choix = props[Number(num[1]) - 1];
      if (!choix) {
        const c = matchChambre(brut);
        if (c) choix = props.filter((p) => p.chambreId === c.id)[0] || null;
      }
      if (choix) {
        session.chambreId = choix.chambreId; session.arrivee = choix.arrivee; session.depart = choix.depart; session.nuits = dt.nuitsEntre(choix.arrivee, choix.depart);
        session.proposals = null;
        return avancer(session);
      }
      if (parseNegative(brut) || parseWantsSomethingElse(brut)) {
        if (session.reportSejourId) return abandonnerReport(session);
        session.arrivee = null; session.depart = null; session.nuits = null; session.proposals = null;
        session.stage = "awaiting_dates";
        return sh.t(session, "Pas de souci. Quelles dates vous conviendraient mieux ?", "No problem. Which dates would suit you better?");
      }
      const avant = JSON.stringify([session.chambreId, session.arrivee, session.depart]);
      if (absorber(session, brut) && JSON.stringify([session.chambreId, session.arrivee, session.depart]) !== avant) { session.proposals = null; return avancer(session); }
      return sh.t(session, "Je n'ai pas compris votre choix. Répondez par le numéro de l'option (1, 2, 3) ou donnez-moi d'autres dates.", "I didn't understand your choice. Reply with the option number (1, 2, 3) or give me other dates.");
    }

    if (session.stage === "awaiting_dates") {
      if (parseNegative(brut) || parseWantsSomethingElse(brut)) {
        if (session.reportSejourId) return abandonnerReport(session);
        resetSession(session);
        return messageChoixChambre(session, "Pas de souci ! Quelle chambre vous intéresse ?", "No problem! Which room are you interested in?");
      }
      const autre = matchChambre(brut);
      if (autre && autre.id !== session.chambreId && !session.reportSejourId) session.chambreId = autre.id;
      const reconnu = absorber(session, brut, { lirePersonnes: false });
      if (!reconnu) {
        return sh.t(session, "Je n'ai pas compris les dates. Écrivez par exemple « du 12 au 15 novembre » ou « vendredi pour 2 nuits ».", "I didn't understand the dates. For example write \"from 12 to 15 November\" or \"Friday for 2 nights\".");
      }
      return avancer(session);
    }

    // ---- idle : on reconnait au mieux ce que le client a deja dit (chambre, dates, personnes) ----
    const reconnu = absorber(session, brut);
    if (!reconnu || !session.chambreId) {
      const nomAccueil = String(nomMarchandOption() || "").trim();
      if (reconnu && !session.chambreId) {
        // dates donnees sans chambre : on les garde et on demande la chambre
        return messageChoixChambre(session, "Très bien ! Quelle chambre vous intéresse ?", "Great! Which room are you interested in?");
      }
      const perso = accueilPerso(session);
      if (perso) {
        const rep = messageChoixChambre(session, perso + "\n\nQuelle chambre vous intéresse ?", perso + "\n\nWhich room are you interested in?");
        session.accueilPersoAffiche = true;
        return rep;
      }
      return nomAccueil
        ? messageChoixChambre(session, "Bonjour ! Bienvenue chez " + nomAccueil + ". Quelle chambre vous intéresse ?", "Hello! Welcome to " + nomAccueil + ". Which room are you interested in?")
        : messageChoixChambre(session, "Bonjour ! Quelle chambre vous intéresse ?", "Hello! Which room are you interested in?");
    }
    return avancer(session);
  }

  // ---------------- Point d'entree d'un message ----------------
  function handleMessage(fromPhone, text, opts) {
    const reponse = traiterMessage(fromPhone, text, opts);
    if (reponse && sessions[fromPhone]) sessions[fromPhone].derniereReponse = reponse;
    persistance.enregistrer(fromPhone);
    return reponse;
  }

  function reponseDeReprise(fromPhone) {
    const s = sessions[fromPhone];
    if (!s || !s.derniereReponse) return null;
    const enCours = s.stage !== "idle" || !!s.attenteChoixContactHumain;
    return enCours ? s.derniereReponse : null;
  }

  function intentionSejour(text) {
    // « annuler mon sejour / ma chambre / my stay » : on les assimile a une reservation pour le detecteur partage
    const t = String(text || "").replace(/\b(s[ée]jour|sejour|stay|chambre|room)\b/gi, "réservation");
    return sh.detecterIntentionRdv(t);
  }

  function traiterMessage(fromPhone, text, opts) {
    if (!state) return sh.t(sessions[fromPhone], "Le service redémarre, un instant s'il vous plaît...", "The service is restarting, one moment please...");
    if (!(opts && opts.sansJournalClient)) journaliser(fromPhone, "client", text);

    const sessionExistante = sessions[fromPhone];
    if (sessionExistante && sessionExistante.attenteChoixContactHumain) {
      sessionExistante.attenteChoixContactHumain = false;
      const veutAppel = sh.detecteChoixAppel(text);
      const texteOrigine = sessionExistante.texteDemandeHumainOrigine || text;
      delete sessionExistante.texteDemandeHumainOrigine;
      sh.ajouterMessageHistorique(conversationsHumain, fromPhone, "client", text);
      if (veutAppel) {
        notifierMarchand("humain", [fromPhone, sh.PREFIXE_PREFERENCE_APPEL + texteOrigine]).catch((erreur) => console.error("[" + merchantKey + "] Echec de la notification marchand (appel) :", erreur));
      }
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
      let confirmationLangue = sh.t(session, "Très bien, je continue en français. 🇫🇷", "Sure, I'll continue in English. 🇬🇧");
      if (reprisePauseHumain) confirmationLangue = sh.messageReprisePause(session) + "\n\n" + confirmationLangue;
      journaliser(fromPhone, "bot", confirmationLangue);
      return confirmationLangue;
    }

    const estPremierContact = !humanHintDonne[fromPhone];

    if (sh.demandeUnHumain(text)) {
      session.attenteChoixContactHumain = true;
      session.texteDemandeHumainOrigine = text;
      sh.demarrerPauseHumain(conversationsHumain, fromPhone, text);
      notifierMarchand("humain", [fromPhone, text]).catch((erreur) => console.error("[" + merchantKey + "] Echec de la notification marchand (humain) :", erreur));
      let msgChoix = sh.messageChoixContact(session);
      if (reprisePauseHumain) msgChoix = sh.messageReprisePause(session) + "\n\n" + msgChoix;
      journaliser(fromPhone, "bot", msgChoix);
      return msgChoix;
    }

    const intention = intentionSejour(text);
    let reponse;
    ignorerSejourId = session.reportSejourId || null;
    try {
      reponse = intention ? gererAnnulationOuReport(session, intention, !!(opts && opts.confirmerAnnulation)) : processMessage(session, String(text == null ? "" : text));
    } finally {
      ignorerSejourId = null;
    }
    if (estPremierContact && reponse) { humanHintDonne[fromPhone] = true; reponse += sh.mentionHumainDisponible(session); }
    if (reprisePauseHumain && reponse) reponse = sh.messageReprisePause(session) + "\n\n" + reponse;
    journaliser(fromPhone, "bot", reponse);
    return reponse;
  }

  // ---------------- Conversations avec un humain, langue, etat (memes contrats que les autres moteurs) ----------------
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

  function getEtatSession(fromPhone) {
    const s = sessions[fromPhone];
    if (!s) return null;
    const props = s.proposals || null;
    return {
      stage: s.stage,
      pretPourChoix: !!s.pretPourChoix,
      // Memes noms que le moteur service pour que le serveur reutilise ses menus : « creneaux » = propositions.
      proposedSlots: props,
      proposedSlotsLabels: (props || []).map((p) => libelleCourtProposition(p, s)),
      rdvChoix: s.stage === "awaiting_rdv_choice" && s.choixIds
        ? s.choixIds.map((id) => sejourParId(id)).filter(Boolean).map((x) => ({ ref: refSejour(x), detail: x.chambre + " — " + formatCourt(x.arrivee, s) + " → " + formatCourt(x.depart, s) }))
        : null,
      libelleChoix: { fr: "Vos réservations", en: "Your bookings" },
      accueilPerso: !!s.pretPourChoix && !!s.accueilPersoAffiche, // Etape 70
      choixDate: choixDateDe(fromPhone), // Etape 68 : "arrivee" | "nuits" | null
      langue: sh.langueSession(s)
    };
  }

  // ---------------- API pour /admin ----------------
  // ---------------- Etape 68 : listes d'arrivees puis de nuits (menus deroulants WhatsApp) ----------------
  // Le moteur ne fait que calculer ce qui est libre pour la chambre choisie ; server.js construit les listes et renvoie
  // le choix du client comme du texte ordinaire (« AAAA-MM-JJ » pour l'arrivee, « 3 nuits » / « 3 nights » ensuite) que ce
  // moteur comprend deja. La saisie libre reste possible a tout moment. Reglage : settings.listesDatesHeures (vrai par defaut).
  function listesActives() { return !state || !state.settings || state.settings.listesDatesHeures !== false; }
  function contexteListes(fromPhone) {
    if (!state || !listesActives()) return null;
    const s = sessions[fromPhone];
    if (!s || s.stage !== "awaiting_dates") return null;
    const chambre = s.chambreId ? chambreParId(s.chambreId) : null;
    return chambre ? { s, chambre } : null;
  }
  function avecReport(session, fn) {
    const avant = ignorerSejourId;
    ignorerSejourId = session.reportSejourId || null;
    try { return fn(); } finally { ignorerSejourId = avant; }
  }
  // Nombre de nuits consecutives libres a partir de `arriveeIso` (plafonne a `plafond`).
  function nuitsLibresDepuis(chambre, arriveeIso, plafond, pourSim) {
    let n = 0;
    while (n < plafond && disponible(chambre, arriveeIso, dt.ajouterJours(arriveeIso, n + 1), pourSim)) n++;
    return n;
  }
  function nuitsMaxReglage() { return parseInt(reg().nuitsMax, 10) || NUITS_MAX_DEFAUT; }
  // Etape a proposer : "arrivee" (aucune date donnee), "nuits" (arrivee connue, duree manquante) ou null.
  function choixDateDe(fromPhone) {
    const ctx = contexteListes(fromPhone);
    if (!ctx) return null;
    if (!ctx.s.arrivee) return "arrivee";
    if (!ctx.s.depart && !ctx.s.nuits) return "nuits";
    return null;
  }
  // Jours d'arrivee possibles (au moins une nuit libre), par pages de 7 : { jours:[{id,label,description}], suite, page } ou null.
  function getChoixArrivees(fromPhone, page) {
    const ctx = contexteListes(fromPhone);
    if (!ctx || choixDateDe(fromPhone) !== "arrivee") return null;
    return avecReport(ctx.s, () => {
      const pourSim = fromPhone === PHONE_SIMULATEUR;
      const auj = aujourdhuiISO();
      const horizon = Math.min(parseInt(reg().avanceMaxJours, 10) || AVANCE_MAX_JOURS_DEFAUT, 90);
      const trouves = [];
      for (let i = 0; i < horizon; i++) {
        const jour = dt.ajouterJours(auj, i);
        if (disponible(ctx.chambre, jour, dt.ajouterJours(jour, 1), pourSim)) trouves.push({ jour, i });
      }
      const pg = Math.max(0, parseInt(page, 10) || 0);
      const part = trouves.slice(pg * 7, pg * 7 + 7);
      const plafond = Math.min(nuitsMaxReglage(), 14);
      return {
        page: pg,
        suite: trouves.length > pg * 7 + 7,
        jours: part.map((j) => {
          const n = nuitsLibresDepuis(ctx.chambre, j.jour, plafond, pourSim);
          return {
            id: j.jour,
            label: formatCourt(j.jour, ctx.s),
            description: (j.i === 0 ? sh.t(ctx.s, "Aujourd'hui — ", "Today — ") : j.i === 1 ? sh.t(ctx.s, "Demain — ", "Tomorrow — ") : "") +
              (n >= plafond ? sh.t(ctx.s, "Disponible", "Available") : sh.t(ctx.s, "Jusqu'à " + libelleNuits(n, ctx.s), "Up to " + libelleNuits(n, ctx.s)))
          };
        })
      };
    });
  }
  // Durees possibles apres l'arrivee choisie : 1 a 7 nuits (moins si la chambre n'est plus libre ou si nuitsMax est plus bas).
  function getChoixNuits(fromPhone) {
    const ctx = contexteListes(fromPhone);
    if (!ctx || choixDateDe(fromPhone) !== "nuits") return null;
    return avecReport(ctx.s, () => {
      const pourSim = fromPhone === PHONE_SIMULATEUR;
      const max = nuitsLibresDepuis(ctx.chambre, ctx.s.arrivee, Math.min(nuitsMaxReglage(), 7), pourSim);
      const options = [];
      for (let n = 1; n <= max; n++) {
        const depart = dt.ajouterJours(ctx.s.arrivee, n);
        options.push({ id: String(n), nuits: n, label: libelleNuits(n, ctx.s), description: sh.t(ctx.s, "Départ le ", "Departure ") + formatCourt(depart, ctx.s) });
      }
      return { arriveeLabel: formatJour(ctx.s.arrivee, ctx.s), options };
    });
  }

  function getChambres() { return state ? state.chambres : []; }
  function getSettings() { return state ? state.settings : {}; }

  function updateChambres(liste) {
    if (!state || !Array.isArray(liste)) return null;
    const propres = [];
    const vus = new Set();
    for (let i = 0; i < liste.length; i++) {
      const c = liste[i] || {};
      const nom = String(c.nom == null ? "" : c.nom).trim().slice(0, 80);
      if (!nom) continue;
      const nombre = parseInt(c.nombre, 10);
      const prix = parseInt(c.prix, 10);
      const capacite = parseInt(c.capacite, 10);
      let id = String(c.id || "").trim() || "c" + Date.now().toString(36) + "_" + i;
      while (vus.has(id)) id += "_";
      vus.add(id);
      propres.push({
        id, nom,
        nombre: Number.isFinite(nombre) && nombre >= 0 ? Math.min(nombre, 500) : 1,
        prix: Number.isFinite(prix) && prix >= 0 ? prix : 0,
        capacite: Number.isFinite(capacite) && capacite >= 1 ? Math.min(capacite, 50) : 2,
        description: String(c.description == null ? "" : c.description).trim().slice(0, 200)
      });
    }
    state.chambres = propres;
    saveState();
    return state.chambres;
  }

  function updateSettings(patch) {
    if (!state) return;
    const sain = Object.assign({}, patch || {});
    if (sain.fuseau !== undefined && !sh.fuseauValide(sain.fuseau)) delete sain.fuseau;
    ["heureArrivee", "heureDepart"].forEach((k) => { if (sain[k] !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(sain[k]))) delete sain[k]; });
    if (sain.delaiAnnulationHeures !== undefined) { const h = parseFloat(sain.delaiAnnulationHeures); sain.delaiAnnulationHeures = Number.isFinite(h) && h >= 0 ? Math.min(h, 720) : 0; }
    if (sain.modeDelaiDepasse !== undefined) sain.modeDelaiDepasse = sain.modeDelaiDepasse === "accepter" ? "accepter" : "refuser";
    ['messageAccueilSupplementaire', 'messageAccueilSupplementaireEn'].forEach((k) => { if (sain[k] !== undefined) sain[k] = String(sain[k] == null ? '' : sain[k]).trim().slice(0, 600); });
    if (sain.listesDatesHeures !== undefined) sain.listesDatesHeures = !(sain.listesDatesHeures === false || sain.listesDatesHeures === "false" || sain.listesDatesHeures === 0);
    if (sain.nuitsMax !== undefined) { const n = parseInt(sain.nuitsMax, 10); sain.nuitsMax = Number.isFinite(n) && n >= 1 ? Math.min(n, 365) : NUITS_MAX_DEFAUT; }
    if (sain.avanceMaxJours !== undefined) { const n = parseInt(sain.avanceMaxJours, 10); sain.avanceMaxJours = Number.isFinite(n) && n >= 1 ? Math.min(n, 1095) : AVANCE_MAX_JOURS_DEFAUT; }
    state.settings = Object.assign({}, state.settings, sain);
    saveState();
    return state.settings;
  }

  function getSejours() {
    if (!state) return [];
    return state.sejours.filter((s) => s.source !== "simulateur").map((s) => Object.assign({}, s, { reference: refSejour(s) }));
  }
  function getSejourParId(id) { const s = sejourParId(id); return s ? Object.assign({}, s, { reference: refSejour(s) }) : null; }

  // Un sejour peut-il OCCUPER ce type de chambre sur ces dates (en ignorant `ignorerId`) ?
  function libreSansLui(chambreId, arrivee, depart, ignorerId, pourSim) {
    ignorerSejourId = ignorerId || null;
    try { return disponible(chambreParId(chambreId), arrivee, depart, pourSim); } finally { ignorerSejourId = null; }
  }

  function messageOccupe() { return "Aucune chambre de ce type n'est libre sur toutes ces nuits (voir le calendrier)."; }

  function validerPeriodeAdmin(arrivee, depart) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(arrivee || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(depart || ""))) return "Dates invalides (format AAAA-MM-JJ attendu).";
    const a = arrivee.split("-").map(Number), d = depart.split("-").map(Number);
    if (!dt.dateValide(a[0], a[1], a[2]) || !dt.dateValide(d[0], d[1], d[2])) return "Dates invalides.";
    if (depart <= arrivee) return "La date de départ doit être après l'arrivée.";
    if (dt.nuitsEntre(arrivee, depart) > 365) return "Séjour trop long (365 nuits maximum).";
    return null;
  }

  // Nouveau sejour saisi par la reception (appel, passage au comptoir) : bloque la chambre des qu'il est « Confirmé ».
  function creerSejourAdmin(o) {
    if (!state) return { erreur: "indisponible", message: "Service indisponible." };
    o = o || {};
    const chambre = chambreParId(o.chambreId);
    if (!chambre) return { erreur: "chambre", message: "Type de chambre inconnu." };
    let depart = o.depart;
    if (!depart && o.nuits && o.arrivee) depart = dt.ajouterJours(o.arrivee, parseInt(o.nuits, 10) || 1);
    const pb = validerPeriodeAdmin(o.arrivee, depart);
    if (pb) return { erreur: "format", message: pb };
    const personnes = parseInt(o.personnes, 10) || 1;
    if (personnes < 1 || personnes > 50) return { erreur: "format", message: "Nombre de personnes invalide." };
    const statut = STATUTS_VALIDES.indexOf(o.statut) !== -1 && o.statut !== "Annulé" ? o.statut : "Confirmé";
    const nom = String(o.clientNom || "").trim().slice(0, 80);
    if (!nom) return { erreur: "format", message: "Le nom du client est requis." };
    if (STATUTS_BLOQUANTS.indexOf(statut) !== -1 && !libreSansLui(chambre.id, o.arrivee, depart, null, false)) return { erreur: "occupe", message: messageOccupe() };
    const nuits = dt.nuitsEntre(o.arrivee, depart);
    const s = {
      id: state.nextId++, statut: "Nouvelle", raisonAnnulation: null, createdAtISO: new Date().toISOString(), source: "admin", fromWhatsapp: null,
      langue: "fr", chambreId: chambre.id, chambre: chambre.nom, arrivee: o.arrivee, depart, nuits, personnes,
      prixNuit: prixNuit(chambre), total: prixNuit(chambre) * nuits, clientNom: nom,
      telephone: String(o.telephone || "").replace(/[^\d+]/g, "").slice(0, 20) || null, remplaceId: null
    };
    state.sejours.push(s);
    changerStatut(s, statut);
    if (o.par) s.creePar = o.par;
    saveState();
    return { sejour: getSejourParId(s.id) };
  }

  // Changement de dates / de type de chambre / de nombre de personnes par la reception.
  function deplacerSejour(id, o) {
    if (!state) return { erreur: "indisponible", message: "Service indisponible." };
    const s = sejourParId(id);
    if (!s) return { erreur: "introuvable", message: "Réservation introuvable." };
    if (["Nouvelle", "Confirmé", "Arrivé"].indexOf(s.statut) === -1) return { erreur: "statut", message: "Seule une réservation « Non confirmée », « Confirmé » ou « Arrivé » peut être modifiée." };
    o = o || {};
    const chambre = chambreParId(o.chambreId || s.chambreId);
    if (!chambre) return { erreur: "chambre", message: "Type de chambre inconnu." };
    const arrivee = o.arrivee || s.arrivee;
    const depart = o.depart || (o.nuits ? dt.ajouterJours(arrivee, parseInt(o.nuits, 10) || 1) : s.depart);
    const pb = validerPeriodeAdmin(arrivee, depart);
    if (pb) return { erreur: "format", message: pb };
    const personnes = o.personnes ? parseInt(o.personnes, 10) : s.personnes;
    if (!(personnes >= 1 && personnes <= 50)) return { erreur: "format", message: "Nombre de personnes invalide." };
    if (STATUTS_BLOQUANTS.indexOf(s.statut) !== -1 && !libreSansLui(chambre.id, arrivee, depart, s.id, s.source === "simulateur")) return { erreur: "occupe", message: messageOccupe() };
    const avant = { arrivee: s.arrivee, depart: s.depart, chambre: s.chambre };
    const nuits = dt.nuitsEntre(arrivee, depart);
    Object.assign(s, { chambreId: chambre.id, chambre: chambre.nom, arrivee, depart, nuits, personnes, prixNuit: prixNuit(chambre), total: prixNuit(chambre) * nuits });
    if (!s.historique) s.historique = [];
    s.historique.push({ statut: s.statut, atISO: new Date().toISOString(), raison: "Modifié depuis /admin (avant : " + avant.chambre + ", " + avant.arrivee + " → " + avant.depart + ")", par: o.par || null });
    s.modifieDepuisAdmin = { atISO: new Date().toISOString(), avant, par: o.par || null };
    saveState();
    return { sejour: getSejourParId(s.id) };
  }

  function updateSejourStatut(id, nouveau, raison) {
    if (!state) return null;
    const s = sejourParId(id);
    if (!s) return null;
    if (STATUTS_VALIDES.indexOf(nouveau) === -1) return { erreur: "statut", message: "Statut invalide." };
    const auj = aujourdhuiISO();
    // Passer a un statut qui occupe une chambre : la chambre doit etre libre (sinon on deplace d'abord).
    if (STATUTS_BLOQUANTS.indexOf(nouveau) !== -1 && STATUTS_BLOQUANTS.indexOf(s.statut) === -1 && s.depart > auj) {
      const debut = s.arrivee > auj ? s.arrivee : auj;
      if (!libreSansLui(s.chambreId, debut, s.depart, s.id, s.source === "simulateur")) return { erreur: "occupe", message: "Aucune chambre de ce type n'est libre pour ces nuits : modifiez d'abord les dates ou le type de chambre." };
    }
    changerStatut(s, nouveau, raison);
    saveState();
    return getSejourParId(s.id);
  }

  // Calendrier d'occupation : pour chaque type de chambre et chaque nuit, combien de chambres sont occupees.
  function getCalendrier(debutIso, nbJours) {
    if (!state) return null;
    const auj = aujourdhuiISO();
    const debut = /^\d{4}-\d{2}-\d{2}$/.test(String(debutIso || "")) ? debutIso : auj;
    const n = Math.max(1, Math.min(parseInt(nbJours, 10) || 14, 62));
    const jours = [];
    for (let i = 0; i < n; i++) jours.push(dt.ajouterJours(debut, i));
    const bloquants = sejoursQuiBloquent(false);
    const lignes = state.chambres.map((c) => ({
      chambreId: c.id, nom: c.nom, nombre: nombreChambres(c), prix: prixNuit(c),
      nuits: jours.map((j) => ({ date: j, occupees: occupees(c.id, j, false, bloquants) }))
    }));
    return { debut, aujourdhui: auj, jours, lignes };
  }

  // ---------------- Tableau de bord ----------------
  function debutPeriode(periode, dateReference) {
    const p = sh.partiesFuseau(dateReference, fz());
    const jour = dt.iso(p.annee, p.mois, p.jour);
    if (periode === "semaine") { const dow = dt.jourSemaineDe(jour); return dt.ajouterJours(jour, -((dow + 6) % 7)); }
    if (periode === "mois") return dt.iso(p.annee, p.mois, 1);
    if (periode === "trimestre") return dt.iso(p.annee, Math.floor((p.mois - 1) / 3) * 3 + 1, 1);
    if (periode === "annee") return dt.iso(p.annee, 1, 1);
    return jour;
  }
  function finPeriode(periode, debut) {
    const p = debut.split("-").map(Number);
    if (periode === "semaine") return dt.ajouterJours(debut, 7);
    if (periode === "mois") return p[1] === 12 ? dt.iso(p[0] + 1, 1, 1) : dt.iso(p[0], p[1] + 1, 1);
    if (periode === "trimestre") { const m = p[1] + 3; return m > 12 ? dt.iso(p[0] + 1, m - 12, 1) : dt.iso(p[0], m, 1); }
    if (periode === "annee") return dt.iso(p[0] + 1, 1, 1);
    return dt.ajouterJours(debut, 1);
  }

  function getTableauDeBord(opts) {
    if (!state) return null;
    const periode = (opts && opts.periode) || "jour";
    const dateReference = (opts && opts.dateReference && !isNaN(new Date(opts.dateReference).getTime())) ? new Date(opts.dateReference) : new Date();
    const debut = debutPeriode(periode, dateReference);
    const fin = finPeriode(periode, debut);
    const auj = aujourdhuiISO();
    const tous = getSejours();
    const actifs = tous.filter((s) => s.statut !== "Annulé");
    // Sejours dont l'ARRIVEE tombe dans la periode (reservations a honorer)
    const dansPeriode = actifs.filter((s) => s.arrivee >= debut && s.arrivee < fin);
    const arrivees = actifs.filter((s) => s.arrivee === auj && ["Confirmé", "Arrivé", "Nouvelle"].indexOf(s.statut) !== -1);
    const departs = actifs.filter((s) => s.depart === auj && ["Confirmé", "Arrivé"].indexOf(s.statut) !== -1);
    const totalChambres = state.chambres.reduce((t, c) => t + nombreChambres(c), 0);
    const bloquants = sejoursQuiBloquent(false);
    const occupeesCeSoir = state.chambres.reduce((t, c) => t + occupees(c.id, auj, false, bloquants), 0);
    const prochains = actifs
      .filter((s) => (s.statut === "Nouvelle" || s.statut === "Confirmé") && s.arrivee >= auj && s.arrivee <= dt.ajouterJours(auj, 7))
      .sort((a, b) => (a.arrivee < b.arrivee ? -1 : a.arrivee > b.arrivee ? 1 : a.id - b.id))
      .slice(0, 10)
      .map((s) => ({ reference: s.reference, chambre: s.chambre, clientNom: s.clientNom, arrivee: s.arrivee, depart: s.depart, nuits: s.nuits, statut: s.statut }));
    const sparkline7j = [];
    for (let d = 6; d >= 0; d--) {
      const jour = dt.ajouterJours(auj, -d);
      sparkline7j.push(actifs.filter((s) => String(s.createdAtISO || "").slice(0, 10) === jour).length);
    }
    const compteurs = {};
    dansPeriode.forEach((s) => { compteurs[s.chambre] = (compteurs[s.chambre] || 0) + 1; });
    const topChambres = Object.keys(compteurs).map((nom) => ({ nom, quantite: compteurs[nom] })).sort((a, b) => b.quantite - a.quantite).slice(0, 4);
    return {
      periode, debut, fin, aujourdhui: auj,
      debutISO: debut + "T12:00:00.000Z", finISO: fin + "T12:00:00.000Z", // lus par le selecteur de periode de /admin
      sejoursPeriode: dansPeriode.length,
      caPeriode: dansPeriode.reduce((t, s) => t + (s.total || 0), 0),
      nonConfirmes: actifs.filter((s) => s.statut === "Nouvelle" && s.arrivee >= auj).length,
      arriveesAujourdhui: arrivees.length,
      departsAujourdhui: departs.length,
      chambresOccupeesCeSoir: occupeesCeSoir,
      chambresTotal: totalChambres,
      tauxOccupation: totalChambres ? Math.round((occupeesCeSoir / totalChambres) * 100) : 0,
      conversationsEnAttente: sh.listerConversationsEnAttente(conversationsHumain).length,
      sparkline7j, topChambres, prochainsSejours: prochains,
      // champs communs lus par certains ecrans partages
      commandesPeriode: dansPeriode.length, alertesStock: 0, ruptures: 0
    };
  }

  // ---------------- Simulateur ----------------
  function handleMessageSimulateur(text, opts) { return { reponse: handleMessage(PHONE_SIMULATEUR, text, opts), trace: null }; }
  function resetSimulateur() {
    delete sessions[PHONE_SIMULATEUR];
    delete conversationsHumain[PHONE_SIMULATEUR];
    delete humanHintDonne[PHONE_SIMULATEUR];
    if (state) {
      const avant = state.sejours.length;
      state.sejours = state.sejours.filter((s) => s.fromWhatsapp !== PHONE_SIMULATEUR);
      if (state.sejours.length !== avant) saveState();
    }
  }

  return {
    type: "hebergement",
    init,
    balayerSessions: () => persistance.balayer(),
    handleMessage,
    getEtatSession,
    getChoixArrivees,
    getChoixNuits,
    nbSejoursAVenir,
    detailSejoursAVenir,
    definirLangueSession,
    reponseDeReprise,
    estEnPauseHumain,
    langueDeSession,
    getConversationsEnAttente,
    repondreConversationHumain,
    getChambres,
    updateChambres,
    getSettings,
    updateSettings,
    getSejours,
    getSejourParId,
    creerSejourAdmin,
    deplacerSejour,
    updateSejourStatut,
    getCalendrier,
    getTableauDeBord,
    handleMessageSimulateur,
    resetSimulateur,
    aujourdhuiISO
  };
}

module.exports = createHebergementEngine;
