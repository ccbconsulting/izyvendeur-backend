// IzyVendeur - Moteur de conversation "service" (prise de rendez-vous WhatsApp)
//
// Meme esprit que le moteur "catalogue" (conversation.js) mais pour un marchand qui vend du temps plutot
// que des articles : coiffeur, institut de beaute, clinique, garage... Le client nomme un service, indique
// un jour/une heure, le moteur verifie la disponibilite (une seule ressource par marchand - ex: un seul
// fauteuil/praticien a la fois - avec des creneaux de duree fixe configurable par le marchand ; chaque
// service occupe un nombre entier de creneaux selon sa propre duree), propose des alternatives si besoin,
// collecte le nom du client, recapitule et demande confirmation - exactement le meme schema de dialogue
// (chaleur, alternatives en cas d'indisponibilite, garde-fous anti-boucle et anti-inondation) que le moteur
// catalogue, pour que les deux volets d'IzyVendeur se sentent coherents du point de vue du client.
//
// Exporte une factory (createServiceEngine(merchantKey)), comme conversation.js : chaque marchand "service"
// a sa propre instance, son propre etat (services + rendez-vous + parametres) et ses propres sessions.

const { SEED_SERVICES, SERVICE_KEYWORDS, DEFAULT_HORAIRES, DEFAULT_DUREE_CRENEAU_MINUTES, DEFAULT_AUTO_CONFIRM_MESSAGE } = require("./services");
const db = require("./db");
const { formatFcfa, piocheParmi, parseAffirmative, parseNegative, parseWantsSomethingElse } = require("./shared");

const STOPWORDS = ["de", "du", "des", "la", "le", "les", "en", "à", "au", "aux", "et", "un", "une", "pour", "avec"];
const DAY_KEYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

// Un rendez-vous "Nouvelle" (pas encore confirme par le client) bloque deja le creneau, pour eviter
// qu'un deuxieme client ne reserve la meme place pendant que le premier n'a pas encore repondu "oui".
const RESERVING_STATUSES_RDV = ["Nouvelle", "Confirmé"];

// Garde-fou anti-inondation, identique en esprit a celui du moteur catalogue.
const MAX_PENDING_APPOINTMENTS_PER_PHONE = 3;
const PENDING_APPOINTMENTS_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 heures

const OUVERTURES_SERVICE = ["Excellent choix !", "Très bon choix !", "Parfait !", "Belle sélection !"];
const OUVERTURES_CRENEAU = ["Parfait,", "Très bien,", "Super,", "Excellente nouvelle,"];
const OUVERTURES_RECAP = ["Très bien !", "Parfait, on y est presque !", "Super !"];

function seedState() {
  return {
    services: JSON.parse(JSON.stringify(SEED_SERVICES)),
    appointments: [],
    nextId: 1,
    settings: {
      horaires: JSON.parse(JSON.stringify(DEFAULT_HORAIRES)),
      dureeCreneauMinutes: DEFAULT_DUREE_CRENEAU_MINUTES,
      autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE
    }
  };
}

function createServiceEngine(merchantKey) {
  let state = null;
  const sessions = {};

  async function init() {
    state = await db.initMerchantState(merchantKey, seedState);
    if (!state.settings) state.settings = seedState().settings;
    if (!state.settings.horaires) state.settings.horaires = JSON.parse(JSON.stringify(DEFAULT_HORAIRES));
    if (!state.settings.dureeCreneauMinutes) state.settings.dureeCreneauMinutes = DEFAULT_DUREE_CRENEAU_MINUTES;
    if (!state.settings.autoConfirmMessage) state.settings.autoConfirmMessage = DEFAULT_AUTO_CONFIRM_MESSAGE;
    if (!state.appointments) state.appointments = [];
  }

  function saveState() {
    if (!state) return;
    db.persistMerchantState(merchantKey, state).catch((erreur) => {
      console.error("[" + merchantKey + "] Erreur de sauvegarde de l'etat (la derniere modification pourrait etre perdue au redemarrage) :", erreur);
    });
  }

  function freshSession() {
    return {
      stage: "idle",
      serviceId: null,
      proposedSlots: null,
      clientNom: null,
      pendingAppointmentId: null
    };
  }

  function getSession(fromPhone) {
    if (!sessions[fromPhone]) sessions[fromPhone] = freshSession();
    sessions[fromPhone].fromPhone = fromPhone;
    return sessions[fromPhone];
  }

  // ---------------- Reconnaissance du service demande ----------------

  function buildServiceIndex() {
    return state.services.map((s) => {
      const extra = SERVICE_KEYWORDS[s.id] || [];
      const nameWords = s.nom
        .toLowerCase()
        .split(/[^a-zà-ÿ0-9]+/)
        .filter((w) => w.length >= 3 && STOPWORDS.indexOf(w) === -1);
      const keywords = [s.nom.toLowerCase()].concat(extra, nameWords).filter((v, i, a) => a.indexOf(v) === i);
      return { id: s.id, keywords };
    });
  }

  function matchService(text) {
    const t = text.toLowerCase();
    const candidates = [];
    buildServiceIndex().forEach((entry) => {
      entry.keywords.forEach((kw) => {
        if (kw && t.indexOf(kw) !== -1) candidates.push({ id: entry.id, len: kw.length });
      });
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.len - a.len);
    return candidates[0].id;
  }

  // ---------------- Reconnaissance de la date / heure demandee dans le texte du client ----------------

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function parseRequestedDate(text, now) {
    const t = text.toLowerCase();
    if (/\bapr[eè]s[- ]?demain\b/.test(t)) { const d = startOfDay(now); d.setDate(d.getDate() + 2); return d; }
    if (/\bdemain\b/.test(t)) { const d = startOfDay(now); d.setDate(d.getDate() + 1); return d; }
    if (/\baujourd['’]?hui\b/.test(t)) return startOfDay(now);
    for (let i = 0; i < DAY_KEYS.length; i++) {
      const nom = DAY_KEYS[i];
      const re = new RegExp("\\b" + nom + "\\b", "i");
      if (re.test(t)) {
        const veutSemaineProchaine = /\bprochain[e]?\b/.test(t);
        const todayIdx = now.getDay();
        let delta = (i - todayIdx + 7) % 7;
        if (delta === 0 && veutSemaineProchaine) delta = 7;
        const d = startOfDay(now);
        d.setDate(d.getDate() + delta);
        return d;
      }
    }
    return null;
  }

  // Ne renvoie que l'heure/minute (a recombiner avec une date par l'appelant).
  function parseRequestedTime(text) {
    const t = text.toLowerCase();
    const m = t.match(/\b(\d{1,2})\s*[h:]\s*(\d{2})?\b/);
    if (m) {
      let heure = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      // Heuristique : dans ce contexte commercial (horaires typiques 8h-18h), "3h" ou "5h" tout seuls
      // designent presque toujours l'apres-midi plutot que le petit matin - on privilegie cette lecture.
      if (heure >= 1 && heure <= 7) heure += 12;
      if (heure >= 0 && heure <= 23 && minute >= 0 && minute < 60) {
        const d = new Date();
        d.setHours(heure, minute, 0, 0);
        return d;
      }
    }
    if (/\bmidi\b/.test(t)) { const d = new Date(); d.setHours(12, 0, 0, 0); return d; }
    return null;
  }

  function combineDateHeure(dateOnly, heureRef) {
    const d = new Date(dateOnly);
    d.setHours(heureRef.getHours(), heureRef.getMinutes(), 0, 0);
    return d;
  }

  function combineDateHeureStr(dateOnly, hhmm) {
    const parts = String(hhmm || "00:00").split(":");
    const d = new Date(dateOnly);
    d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    return d;
  }

  // ---------------- Disponibilite ----------------

  function horaireDuJour(dateOnly) {
    return (state.settings.horaires || {})[DAY_KEYS[dateOnly.getDay()]];
  }

  function candidateStarts(dateOnly) {
    const horaire = horaireDuJour(dateOnly);
    if (!horaire || !horaire.ouvert) return [];
    const pas = state.settings.dureeCreneauMinutes || DEFAULT_DUREE_CRENEAU_MINUTES;
    const debut = combineDateHeureStr(dateOnly, horaire.debut);
    const fin = combineDateHeureStr(dateOnly, horaire.fin);
    const starts = [];
    let cursor = new Date(debut);
    while (cursor.getTime() < fin.getTime()) {
      starts.push(new Date(cursor));
      cursor = new Date(cursor.getTime() + pas * 60000);
    }
    return starts;
  }

  function isSlotFree(slotStart, dureeMinutes) {
    const slotEnd = slotStart.getTime() + dureeMinutes * 60000;
    return !state.appointments.some((a) => {
      if (RESERVING_STATUSES_RDV.indexOf(a.statut) === -1) return false;
      const aStart = new Date(a.dateISO).getTime();
      const aEnd = aStart + (a.dureeMinutes || dureeMinutes) * 60000;
      return slotStart.getTime() < aEnd && aStart < slotEnd;
    });
  }

  function freeSlotsForDay(dateOnly, dureeService, now) {
    const horaire = horaireDuJour(dateOnly);
    if (!horaire || !horaire.ouvert) return [];
    const fin = combineDateHeureStr(dateOnly, horaire.fin);
    return candidateStarts(dateOnly)
      .filter((s) => s.getTime() + dureeService * 60000 <= fin.getTime())
      .filter((s) => s.getTime() > now.getTime())
      .filter((s) => isSlotFree(s, dureeService));
  }

  // Cherche les prochains creneaux libres a partir d'un jour donne (inclus), en avancant jour par jour
  // (jusqu'a 14 jours) - utilise quand le jour demande par le client n'a plus aucune place libre.
  function nextAvailableFrom(dateOnly, dureeService, now, need) {
    const out = [];
    let cursor = new Date(dateOnly);
    for (let i = 0; i < 14 && out.length < need; i++) {
      const slots = freeSlotsForDay(cursor, dureeService, now);
      for (let j = 0; j < slots.length && out.length < need; j++) out.push(slots[j]);
      cursor = new Date(cursor); cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function formatSlot(d) {
    const jour = capitalize(DAY_KEYS[d.getDay()]);
    const jj = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return jour + " " + jj + "/" + mm + " à " + hh + "h" + (mi === "00" ? "" : mi);
  }

  function matchSlotChoice(text, proposedSlots) {
    if (!proposedSlots || !proposedSlots.length) return null;
    const t = text.toLowerCase().trim();
    const heure = parseRequestedTime(text);
    if (heure) {
      const match = proposedSlots.filter((s) => s.getHours() === heure.getHours() && s.getMinutes() === heure.getMinutes())[0];
      if (match) return match;
    }
    const ordinalMap = {
      "1": 0, "premier": 0, "le premier": 0, "un": 0,
      "2": 1, "deuxieme": 1, "deuxième": 1, "le deuxieme": 1, "le deuxième": 1, "2eme": 1, "2ème": 1,
      "3": 2, "troisieme": 2, "troisième": 2, "le troisieme": 2, "le troisième": 2, "3eme": 2, "3ème": 2
    };
    if (ordinalMap.hasOwnProperty(t) && proposedSlots[ordinalMap[t]]) return proposedSlots[ordinalMap[t]];
    return null;
  }

  // ---------------- Rendez-vous ----------------

  function orderRef(a) {
    return "RDV-" + String(a.id).padStart(4, "0");
  }

  function createAppointment(session, slotStart, service) {
    const appt = {
      id: state.nextId++,
      dateISO: slotStart.toISOString(),
      createdAtISO: new Date().toISOString(),
      serviceId: service.id,
      service: service.nom,
      dureeMinutes: service.dureeMinutes,
      prix: service.prix,
      clientNom: session.clientNom,
      telephone: session.fromPhone,
      statut: "Nouvelle",
      raisonAnnulation: null,
      source: "whatsapp",
      fromWhatsapp: session.fromPhone || null
    };
    state.appointments.push(appt);
    saveState();
    return appt;
  }

  function applyStatusChange(appt, newStatus, raisonAnnulation) {
    if (appt.statut === newStatus) {
      if (newStatus === "Annulé" && raisonAnnulation) appt.raisonAnnulation = raisonAnnulation;
      return;
    }
    appt.statut = newStatus;
    if (newStatus === "Annulé") appt.raisonAnnulation = raisonAnnulation || appt.raisonAnnulation || null;
    else appt.raisonAnnulation = null;
    saveState();
  }

  // Point d'entree commun : a partir d'un service et d'un texte, tente de comprendre jour/heure et
  // renvoie soit une confirmation directe de creneau, soit une liste d'alternatives a choisir.
  function handleDateTimeAttempt(session, text, service) {
    const now = new Date();
    const dateDemandee = parseRequestedDate(text, now);
    const heureDemandee = parseRequestedTime(text);

    if (!dateDemandee && !heureDemandee) {
      session.stage = "awaiting_datetime";
      return "Quel jour et à quelle heure vous conviendrait pour votre " + service.nom + " ?";
    }

    let dateOnly = dateDemandee || startOfDay(now);
    if (!dateDemandee && heureDemandee) {
      // Heure seule, sans jour : on suppose aujourd'hui si le creneau n'est pas deja passe, sinon demain.
      const essai = combineDateHeure(dateOnly, heureDemandee);
      if (essai.getTime() <= now.getTime()) { dateOnly = startOfDay(now); dateOnly.setDate(dateOnly.getDate() + 1); }
    }

    if (heureDemandee) {
      const exact = combineDateHeure(dateOnly, heureDemandee);
      const dejaPasse = exact.getTime() <= now.getTime();
      const dansHoraires = candidateStarts(dateOnly).some((s) => s.getTime() === exact.getTime());
      if (!dejaPasse && dansHoraires && exact.getTime() + service.dureeMinutes * 60000 <= combineDateHeureStr(dateOnly, (horaireDuJour(dateOnly) || {}).fin || "18:00").getTime() && isSlotFree(exact, service.dureeMinutes)) {
        return bookSlot(session, exact, service);
      }
    }

    // Creneau exact indisponible (ou seul le jour a ete donne) : on propose jusqu'a 3 alternatives.
    let alternatives = freeSlotsForDay(dateOnly, service.dureeMinutes, now);
    if (heureDemandee && alternatives.length) {
      const cible = combineDateHeure(dateOnly, heureDemandee).getTime();
      alternatives = alternatives.slice().sort((a, b) => Math.abs(a.getTime() - cible) - Math.abs(b.getTime() - cible));
    }
    alternatives = alternatives.slice(0, 3);
    let messagePrefixe = "";
    if (!alternatives.length) {
      const suite = new Date(dateOnly); suite.setDate(suite.getDate() + 1);
      alternatives = nextAvailableFrom(suite, service.dureeMinutes, now, 3);
      messagePrefixe = "Désolée, plus aucune place ce jour-là 😕 ";
    } else if (heureDemandee) {
      messagePrefixe = "Ce créneau n'est pas disponible. ";
    }

    if (!alternatives.length) {
      session.stage = "awaiting_datetime";
      return messagePrefixe + "Je ne trouve pas de créneau disponible dans les prochains jours pour " + service.nom + ". Quel autre jour souhaitez-vous essayer ?";
    }

    session.proposedSlots = alternatives;
    session.stage = "awaiting_slot_choice";
    const liste = alternatives.map((s, i) => (i + 1) + ". " + formatSlot(s)).join("\n");
    return messagePrefixe + piocheParmi(OUVERTURES_CRENEAU) + " voici les prochaines disponibilités pour " + service.nom + " :\n" + liste + "\n\nLequel vous convient ? (répondez par l'heure ou le numéro)";
  }

  function bookSlot(session, slotStart, service) {
    session.pendingSlotISO = slotStart.toISOString();
    session.stage = "awaiting_client_name";
    return piocheParmi(OUVERTURES_CRENEAU) + " le " + formatSlot(slotStart) + " est disponible pour " + service.nom + " (" + formatFcfa(service.prix) + "). À quel nom dois-je noter ce rendez-vous ?";
  }

  function processMessage(session, text) {
    if (session.stage === "awaiting_datetime") {
      const autreService = matchService(text);
      if (autreService && autreService !== session.serviceId) {
        Object.assign(session, freshSession());
        return processMessage(session, text);
      }
      if (parseNegative(text) || parseWantsSomethingElse(text)) {
        Object.assign(session, freshSession());
        return "Pas de souci ! Quel service vous intéresse ? Nous proposons : " + state.services.map((s) => s.nom).join(", ") + ".";
      }
      const service = state.services.filter((s) => s.id === session.serviceId)[0];
      return handleDateTimeAttempt(session, text, service);
    }

    if (session.stage === "awaiting_slot_choice") {
      const choisi = matchSlotChoice(text, session.proposedSlots);
      const service = state.services.filter((s) => s.id === session.serviceId)[0];
      if (choisi) {
        return bookSlot(session, choisi, service);
      }
      if (parseNegative(text) || parseWantsSomethingElse(text)) {
        Object.assign(session, freshSession());
        return "Pas de souci ! Quel service vous intéresse ? Nous proposons : " + state.services.map((s) => s.nom).join(", ") + ".";
      }
      const autreService = matchService(text);
      if (autreService && autreService !== session.serviceId) {
        Object.assign(session, freshSession());
        return processMessage(session, text);
      }
      // Le client tente peut-etre un autre jour/heure plutot que l'une des propositions - on retente.
      const nouvelleTentative = handleDateTimeAttempt(session, text, service);
      if (session.stage !== "awaiting_slot_choice" || session.proposedSlots) return nouvelleTentative;
      return "Je n'ai pas compris votre choix. Répondez par l'heure souhaitée (ex : 10h) ou par son numéro (1, 2, 3).";
    }

    if (session.stage === "awaiting_client_name") {
      const nom = text.trim().slice(0, 80);
      if (!nom) return "Merci d'indiquer le nom à noter pour ce rendez-vous.";
      session.clientNom = nom;

      // Anti-inondation : base sur la date de CREATION du rendez-vous (createdAtISO), pas sur la date
      // du creneau reserve (dateISO, toujours dans le futur) — sinon la fenetre glissante ne se
      // declencherait jamais.
      const now = Date.now();
      const recentCount = state.appointments.filter((a) => {
        if (a.fromWhatsapp !== session.fromPhone || a.statut !== "Nouvelle") return false;
        const age = now - new Date(a.createdAtISO || a.dateISO).getTime();
        return age >= 0 && age < PENDING_APPOINTMENTS_WINDOW_MS;
      }).length;
      if (recentCount >= MAX_PENDING_APPOINTMENTS_PER_PHONE) {
        Object.assign(session, freshSession());
        return "Vous avez déjà " + recentCount + " rendez-vous en attente de confirmation. Merci de confirmer ou d'annuler l'un d'entre eux avant d'en prendre un nouveau — notre équipe reste disponible si besoin.";
      }

      const service = state.services.filter((s) => s.id === session.serviceId)[0];
      const slotStart = new Date(session.pendingSlotISO);
      if (!isSlotFree(slotStart, service.dureeMinutes)) {
        // Un autre client a pris ce creneau entre-temps (course tres rare mais possible) : on repropose.
        session.pendingSlotISO = null;
        return handleDateTimeAttempt(session, "", service) || "Ce créneau vient d'être pris par quelqu'un d'autre, quel autre jour/heure vous conviendrait ?";
      }
      const appt = createAppointment(session, slotStart, service);
      session.pendingAppointmentId = appt.id;
      session.stage = "awaiting_confirmation";
      return piocheParmi(OUVERTURES_RECAP) + " Voici le récapitulatif de votre rendez-vous (" + orderRef(appt) + ") :\n" +
        "• " + service.nom + " — " + formatSlot(slotStart) + " — " + formatFcfa(service.prix) + "\n" +
        "Au nom de : " + session.clientNom + "\n\nConfirmez-vous ce rendez-vous ? (oui / non)";
    }

    if (session.stage === "awaiting_confirmation") {
      const appt = state.appointments.filter((a) => a.id === session.pendingAppointmentId)[0];
      if (appt && parseAffirmative(text)) {
        applyStatusChange(appt, "Confirmé");
        const reply = (state.settings && state.settings.autoConfirmMessage) || DEFAULT_AUTO_CONFIRM_MESSAGE;
        Object.assign(session, freshSession());
        return reply;
      }
      if (appt && parseNegative(text)) {
        const reply = "Très bien, votre rendez-vous reste enregistré. Notre équipe reviendra vers vous pour le confirmer.";
        Object.assign(session, freshSession());
        return reply;
      }
      if (appt) {
        return "Je n'ai pas bien compris. Confirmez-vous votre rendez-vous " + orderRef(appt) + " ? Répondez simplement par oui ou non — notre équipe reviendra vers vous pour toute autre question.";
      }
      const reply = "Très bien, votre rendez-vous reste enregistré.";
      Object.assign(session, freshSession());
      return reply;
    }

    // Etat "idle" : on essaie de reconnaitre le service demande.
    const serviceId = matchService(text);
    if (!serviceId) {
      return "Bonjour ! Quel service vous intéresse ? Nous proposons : " + state.services.map((s) => s.nom).join(", ") + ".";
    }
    session.serviceId = serviceId;
    const service = state.services.filter((s) => s.id === serviceId)[0];
    // Le petit mot gentil sort a chaque fois que le service vient d'etre reconnu dans CE message (ici
    // toujours vrai, puisqu'on entre dans ce bloc seulement depuis l'etat "idle"), pas a chaque relance
    // ensuite - meme regle que dans le moteur catalogue.
    return piocheParmi(OUVERTURES_SERVICE) + " " + handleDateTimeAttempt(session, text, service);
  }

  function handleMessage(fromPhone, text) {
    if (!state) return "Le service redemarre, un instant s'il vous plait...";
    const session = getSession(fromPhone);
    return processMessage(session, text);
  }

  function getAppointments() { return state ? state.appointments : []; }
  function getServices() { return state ? state.services : []; }
  function getSettings() { return state ? state.settings : {}; }

  function updateSettings(patch) {
    if (!state) return;
    state.settings = Object.assign({}, state.settings, patch);
    saveState();
    return state.settings;
  }

  function updateServices(newServices) {
    if (!state || !Array.isArray(newServices)) return null;
    state.services = newServices;
    saveState();
    return state.services;
  }

  function updateAppointmentStatus(apptId, newStatus, raisonAnnulation) {
    if (!state) return null;
    const appt = state.appointments.filter((a) => a.id === Number(apptId))[0];
    if (!appt) return null;
    applyStatusChange(appt, newStatus, raisonAnnulation);
    return appt;
  }

  return {
    type: "service",
    init,
    handleMessage,
    getAppointments,
    getServices,
    getSettings,
    updateSettings,
    updateServices,
    updateAppointmentStatus
  };
}

module.exports = createServiceEngine;
