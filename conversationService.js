// IzyVendeur - Moteur de conversation "service" (prise de rendez-vous WhatsApp)
//
// Meme esprit que le moteur "catalogue" (conversation.js) mais pour un marchand qui vend du temps plutot
// que des articles : coiffeur, institut de beaute, clinique, garage... Le client nomme un service, indique
// un jour/une heure, le moteur verifie la disponibilite (par defaut une seule ressource par marchand - ex:
// un seul fauteuil/praticien a la fois - mais plusieurs praticiens peuvent etre configures en parallele,
// voir "Praticiens" plus bas), avec des creneaux de duree fixe configurable par le marchand ; chaque
// service occupe un nombre entier de creneaux selon sa propre duree, et plusieurs services peuvent etre
// combines dans une meme reservation. Propose des alternatives si besoin, collecte le nom du client,
// recapitule et demande confirmation - exactement le meme schema de dialogue (chaleur, alternatives en cas
// d'indisponibilite, garde-fous anti-boucle et anti-inondation) que le moteur catalogue, pour que les deux
// volets d'IzyVendeur se sentent coherents du point de vue du client.
//
// Exporte une factory (createServiceEngine(merchantKey)), comme conversation.js : chaque marchand "service"
// a sa propre instance, son propre etat (services + rendez-vous + parametres) et ses propres sessions.

const { SEED_SERVICES, SERVICE_KEYWORDS, DEFAULT_HORAIRES, DEFAULT_DUREE_CRENEAU_MINUTES, DEFAULT_AUTO_CONFIRM_MESSAGE } = require("./services");
const db = require("./db");
const sh = require("./shared");
const { formatFcfa, piocheParmi, parseAffirmative, parseNegative, parseWantsSomethingElse } = sh;

const STOPWORDS = ["de", "du", "des", "la", "le", "les", "en", "à", "au", "aux", "et", "un", "une", "pour", "avec"];
const DAY_KEYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

// Un rendez-vous "Nouvelle" (pas encore confirme par le client) bloque deja le creneau, pour eviter
// qu'un deuxieme client ne reserve la meme place pendant que le premier n'a pas encore repondu "oui".
const RESERVING_STATUSES_RDV = ["Nouvelle", "Confirmé"];

// Garde-fou anti-inondation, identique en esprit a celui du moteur catalogue.
const MAX_PENDING_APPOINTMENTS_PER_PHONE = 3;
const PENDING_APPOINTMENTS_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 heures

// Fenetre de declenchement du rappel automatique (voir envoyerRappelsDuJour plus bas) : entre 20h et 24h
// avant le rendez-vous. Verifiee toutes les INTERVALLE_RAPPELS_MS (voir server.js) - une fenetre de 4h,
// verifiee bien plus souvent que ca, garantit qu'aucun rendez-vous ne passe au travers.
const RAPPEL_DELAI_MIN_MS = 20 * 3600 * 1000;
const RAPPEL_DELAI_MAX_MS = 24 * 3600 * 1000;

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
      autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE,
      // Praticiens (staff) pouvant recevoir des rendez-vous en parallele - voir getPraticiens() plus bas.
      // Vide par defaut : le marchand reste sur l'ancien comportement (une seule ressource a la fois) tant
      // qu'il n'a rien configure depuis /admin > Paramètres > Praticiens.
      praticiens: []
    }
  };
}

// Voir conversation.js pour le detail de `options.envoyer`/`options.notifierMarchand(typeAlerte, params)`
// et de PHONE_SIMULATEUR (numero reserve pour le Simulateur WhatsApp de /admin, jamais un vrai client —
// les rendez-vous crees sous ce numero sont marques source:"simulateur" et exclus partout ailleurs).
const PHONE_SIMULATEUR = "SIMULATEUR";

function createServiceEngine(merchantKey, options) {
  let state = null;
  const sessions = {};
  const conversationsHumain = {}; // memoire seulement (comme `sessions`) - voir shared.js
  const envoyer = (options && options.envoyer) || (async () => {});
  const notifierMarchand = (options && options.notifierMarchand) || (async () => {});
  // `options.journaliser(telephone, de, texte)` enregistre durablement un message dans le journal complet
  // des conversations (voir db.js) - pour l'onglet "Historique" de /admin. Toujours appele en
  // fire-and-forget (jamais attendu, jamais laisse faire planter la conversation en cas d'echec).
  const journaliserOption = (options && options.journaliser) || (async () => {});
  function journaliser(telephone, de, texte) {
    if (!telephone || telephone === PHONE_SIMULATEUR) return; // jamais le Simulateur dans le vrai journal
    journaliserOption(telephone, de, texte).catch((erreur) =>
      console.error("[" + merchantKey + "] Echec de journalisation de la conversation :", erreur)
    );
  }
  // Glisse la mention "un conseiller reste disponible" UNE SEULE fois par client, a sa toute premiere
  // reponse - memoire seulement (comme `sessions`/`conversationsHumain`) : un redemarrage remet a zero,
  // ce qui n'est pas grave (au pire un client tres occasionnel la revoit un jour).
  const humanHintDonne = {};

  async function init() {
    state = await db.initMerchantState(merchantKey, seedState);
    if (!state.settings) state.settings = seedState().settings;
    if (!state.settings.horaires) state.settings.horaires = JSON.parse(JSON.stringify(DEFAULT_HORAIRES));
    if (!state.settings.dureeCreneauMinutes) state.settings.dureeCreneauMinutes = DEFAULT_DUREE_CRENEAU_MINUTES;
    if (!state.settings.autoConfirmMessage) state.settings.autoConfirmMessage = DEFAULT_AUTO_CONFIRM_MESSAGE;
    if (!Array.isArray(state.settings.praticiens)) state.settings.praticiens = [];
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
      // Liste des services combines dans cette reservation (ex: ["s1","s4"] pour "coupe + manucure") -
      // voir matchServicesMultiple()/combinerServices() plus bas. serviceId reste l'id joint ("s1+s4") pour
      // compatibilite avec le reste du code qui identifie une reservation par un seul id.
      serviceIds: null,
      // Praticien demande par le client (id dans settings.praticiens), ou null s'il n'a pas de preference -
      // voir matchPraticien() plus bas. Reste null pour un marchand qui n'a configure aucun praticien.
      praticienId: null,
      // Praticien reellement assigne au creneau en attente de confirmation (resolu au moment de la
      // reservation, meme si le client n'avait pas de preference - voir choisirPraticienLibre()).
      pendingPraticienId: null,
      proposedSlots: null,
      clientNom: null,
      pendingAppointmentId: null,
      // true UNIQUEMENT quand la reponse de CE tour est un "quel service vous interesse ?" - voir
      // getEtatSession() plus bas, utilise par server.js pour decider d'envoyer une liste WhatsApp
      // cliquable plutot qu'un texte simple.
      pretPourChoix: false
    };
  }

  function getSession(fromPhone) {
    if (!sessions[fromPhone]) sessions[fromPhone] = freshSession();
    sessions[fromPhone].fromPhone = fromPhone;
    return sessions[fromPhone];
  }

  // ---------------- Praticiens (staff pouvant recevoir des rendez-vous en parallele) ----------------
  // Un marchand qui n'a rien configure (cas par defaut, et cas de tous les marchands crees avant cette
  // fonctionnalite) reste sur une ressource unique implicite ("_unique", sans nom) - EXACTEMENT le meme
  // comportement qu'avant : aucune mention de praticien nulle part, capacite de 1 rendez-vous a la fois.

  function getPraticiens() {
    const liste = (state.settings && state.settings.praticiens) || [];
    return liste.length ? liste : [{ id: "_unique", nom: null }];
  }

  function praticienNomParId(id) {
    if (!id) return null;
    const p = getPraticiens().filter((x) => x.id === id)[0];
    return p ? p.nom : null;
  }

  // Reconnait un praticien nomme explicitement dans le texte du client (ex: "avec Sandra") - seulement
  // pertinent si le marchand a configure plusieurs praticiens avec un nom ; renvoie null sinon (aucune
  // preference exprimee, un praticien disponible sera choisi automatiquement).
  function matchPraticien(text) {
    const praticiens = getPraticiens().filter((p) => p.nom);
    if (!praticiens.length) return null;
    const t = text.toLowerCase();
    for (const p of praticiens) {
      if (p.nom && t.indexOf(p.nom.toLowerCase()) !== -1) return p.id;
    }
    return null;
  }

  // ---------------- Reconnaissance du/des service(s) demande(s) ----------------

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

  // Reconnait PLUSIEURS services combines dans un meme message ("coupe et manucure", "brushing + soin du
  // visage") en coupant le texte sur les connecteurs usuels et en reconnaissant un service par segment -
  // permet une reservation combinee sans rien changer au reste du moteur (voir combinerServices()
  // ci-dessous, qui fabrique un service "synthetique" traite ensuite exactement comme un service normal
  // partout ailleurs : duree et prix cumules). Renvoie un tableau d'ids distincts, dans l'ordre rencontre
  // (vide si rien reconnu).
  function matchServicesMultiple(text) {
    const segments = text.split(/\bet\b|\+|,|\bavec\b/i).map((s) => s.trim()).filter(Boolean);
    const ids = [];
    segments.forEach((seg) => {
      const id = matchService(seg);
      if (id && ids.indexOf(id) === -1) ids.push(id);
    });
    if (ids.length) return ids;
    // Repli : le decoupage par segments n'a rien donne (texte trop imbrique pour etre coupe proprement) -
    // tente un match global classique sur le texte entier.
    const single = matchService(text);
    return single ? [single] : [];
  }

  // Fabrique un objet "service" a partir d'une liste d'ids - un seul id renvoie le service tel quel ;
  // plusieurs ids fabriquent un service synthetique (nom/duree/prix combines) traite EXACTEMENT comme un
  // service normal par le reste du moteur (handleDateTimeAttempt, bookSlot, createAppointment...), qui ne
  // font que lire service.id/nom/dureeMinutes/prix sans jamais supposer qu'il vient du catalogue brut.
  function combinerServices(ids) {
    const services = (ids || []).map((id) => state.services.filter((s) => s.id === id)[0]).filter(Boolean);
    if (!services.length) return null;
    if (services.length === 1) return services[0];
    return {
      id: services.map((s) => s.id).join("+"),
      nom: services.map((s) => s.nom).join(" + "),
      dureeMinutes: services.reduce((sum, s) => sum + s.dureeMinutes, 0),
      prix: services.reduce((sum, s) => sum + s.prix, 0),
      combo: services.map((s) => s.id)
    };
  }

  // Reconstruit le service (simple ou combine) actuellement en cours de reservation dans cette session -
  // point d'entree unique utilise par tous les stages qui ont besoin de re-deriver `service` a partir de
  // session.serviceIds (au lieu d'un filtre direct sur state.services, qui ne connaitrait pas un id combine
  // comme "s1+s4").
  function serviceActuel(session) {
    const ids = session.serviceIds && session.serviceIds.length ? session.serviceIds : (session.serviceId ? [session.serviceId] : []);
    return combinerServices(ids);
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

  // Pause dejeuner (ou autre coupure) optionnelle au milieu de la journee - ex: 8h-13h puis 14h-18h pour un
  // marchand de type cabinet/conseil. Absente (pauseDebut/pauseFin non renseignes) pour un marchand qui
  // ouvre en continu (ex: institut de beaute) - retro-compatible avec les horaires deja enregistres avant
  // l'introduction de ce champ.
  function pauseDuJour(dateOnly, horaire) {
    if (!horaire || !horaire.pauseDebut || !horaire.pauseFin) return null;
    return { debut: combineDateHeureStr(dateOnly, horaire.pauseDebut), fin: combineDateHeureStr(dateOnly, horaire.pauseFin) };
  }

  // true si le creneau [slotStart, slotStart+dureeMinutes) chevauche la pause du jour (meme logique de
  // chevauchement que isSlotFreePour, plus bas).
  function chevauchePause(dateOnly, horaire, slotStart, dureeMinutes) {
    const pause = pauseDuJour(dateOnly, horaire);
    if (!pause) return false;
    const slotEnd = slotStart.getTime() + dureeMinutes * 60000;
    return slotStart.getTime() < pause.fin.getTime() && pause.debut.getTime() < slotEnd;
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

  // true si le creneau [slotStart, slotStart+dureeMinutes) est libre pour le praticien demande, ou - si
  // praticienId est null (client sans preference) - s'il existe AU MOINS UN praticien libre a ce moment.
  // La "capacite" du marchand est donc le nombre de praticiens configures (1 par defaut quand aucun n'est
  // renseigne, ce qui reproduit exactement l'ancien comportement mono-ressource).
  function isSlotFreePour(slotStart, dureeMinutes, praticienId) {
    const slotEnd = slotStart.getTime() + dureeMinutes * 60000;
    const occupePar = (id) => state.appointments.some((a) => {
      if (a.source === "simulateur") return false; // jamais d'impact du Simulateur sur les vrais creneaux
      if (RESERVING_STATUSES_RDV.indexOf(a.statut) === -1) return false;
      if ((a.praticienId || "_unique") !== id) return false;
      const aStart = new Date(a.dateISO).getTime();
      const aEnd = aStart + (a.dureeMinutes || dureeMinutes) * 60000;
      return slotStart.getTime() < aEnd && aStart < slotEnd;
    });
    if (praticienId) return !occupePar(praticienId);
    return getPraticiens().some((p) => !occupePar(p.id));
  }

  // Choisit un praticien reellement libre pour ce creneau (utilise a la reservation quand le client n'a
  // exprime aucune preference) - le premier libre dans l'ordre configure par le marchand.
  function choisirPraticienLibre(slotStart, dureeMinutes) {
    const libre = getPraticiens().filter((p) => isSlotFreePour(slotStart, dureeMinutes, p.id))[0];
    return libre ? libre.id : null;
  }

  function freeSlotsForDay(dateOnly, dureeService, now, praticienId) {
    const horaire = horaireDuJour(dateOnly);
    if (!horaire || !horaire.ouvert) return [];
    const fin = combineDateHeureStr(dateOnly, horaire.fin);
    return candidateStarts(dateOnly)
      .filter((s) => s.getTime() + dureeService * 60000 <= fin.getTime())
      .filter((s) => !chevauchePause(dateOnly, horaire, s, dureeService))
      .filter((s) => s.getTime() > now.getTime())
      .filter((s) => isSlotFreePour(s, dureeService, praticienId));
  }

  // Cherche les prochains creneaux libres a partir d'un jour donne (inclus), en avancant jour par jour
  // (jusqu'a 14 jours) - utilise quand le jour demande par le client n'a plus aucune place libre.
  function nextAvailableFrom(dateOnly, dureeService, now, need, praticienId) {
    const out = [];
    let cursor = new Date(dateOnly);
    for (let i = 0; i < 14 && out.length < need; i++) {
      const slots = freeSlotsForDay(cursor, dureeService, now, praticienId);
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
    const praticienId = session.pendingPraticienId || null;
    const appt = {
      id: state.nextId++,
      dateISO: slotStart.toISOString(),
      createdAtISO: new Date().toISOString(),
      serviceId: service.id,
      service: service.nom,
      dureeMinutes: service.dureeMinutes,
      prix: service.prix,
      // Praticien assigne (voir choisirPraticienLibre) - null pour un marchand sans praticiens configures,
      // exactement comme avant l'introduction de cette fonctionnalite.
      praticienId: praticienId && praticienId !== "_unique" ? praticienId : null,
      praticienNom: praticienNomParId(praticienId),
      clientNom: session.clientNom,
      telephone: session.fromPhone,
      statut: "Nouvelle",
      raisonAnnulation: null,
      // Rappel automatique la veille (voir envoyerRappelsDuJour) - jamais envoye pour l'instant.
      rappelEnvoye: false,
      source: session.fromPhone === PHONE_SIMULATEUR ? "simulateur" : "whatsapp",
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
    const praticienId = session.praticienId || null;

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
      const horaireJour = horaireDuJour(dateOnly);
      const pauseOk = !chevauchePause(dateOnly, horaireJour, exact, service.dureeMinutes);
      if (!dejaPasse && dansHoraires && pauseOk && exact.getTime() + service.dureeMinutes * 60000 <= combineDateHeureStr(dateOnly, (horaireJour || {}).fin || "18:00").getTime() && isSlotFreePour(exact, service.dureeMinutes, praticienId)) {
        return bookSlot(session, exact, service, praticienId || choisirPraticienLibre(exact, service.dureeMinutes));
      }
    }

    // Creneau exact indisponible (ou seul le jour a ete donne) : on propose jusqu'a 3 alternatives.
    let alternatives = freeSlotsForDay(dateOnly, service.dureeMinutes, now, praticienId);
    if (heureDemandee && alternatives.length) {
      const cible = combineDateHeure(dateOnly, heureDemandee).getTime();
      alternatives = alternatives.slice().sort((a, b) => Math.abs(a.getTime() - cible) - Math.abs(b.getTime() - cible));
    }
    alternatives = alternatives.slice(0, 3);
    let messagePrefixe = "";
    if (!alternatives.length) {
      const suite = new Date(dateOnly); suite.setDate(suite.getDate() + 1);
      alternatives = nextAvailableFrom(suite, service.dureeMinutes, now, 3, praticienId);
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

  function bookSlot(session, slotStart, service, praticienId) {
    session.pendingSlotISO = slotStart.toISOString();
    session.pendingPraticienId = praticienId || null;
    session.stage = "awaiting_client_name";
    // Le nom du praticien n'apparait que si le marchand en a configure plusieurs - pour un seul (ou aucun
    // configure), la mention serait un bruit inutile puisque le client n'a de toute facon aucun choix.
    const mentionPraticien = getPraticiens().length > 1 ? (praticienNomParId(praticienId) ? " avec " + praticienNomParId(praticienId) : "") : "";
    return piocheParmi(OUVERTURES_CRENEAU) + " le " + formatSlot(slotStart) + " est disponible pour " + service.nom + mentionPraticien + " (" + formatFcfa(service.prix) + "). À quel nom dois-je noter ce rendez-vous ?";
  }

  function processMessage(session, text) {
    // Reinitialise a chaque tour - seuls les 3 points de retour "quel service vous interesse ?" plus bas
    // le repassent a true juste avant de renvoyer leur texte (voir freshSession() ci-dessus).
    session.pretPourChoix = false;

    if (session.stage === "awaiting_datetime") {
      const autresServices = matchServicesMultiple(text);
      const memeService = autresServices.length && autresServices.slice().sort().join("+") === (session.serviceIds || []).slice().sort().join("+");
      if (autresServices.length && !memeService) {
        Object.assign(session, freshSession());
        return processMessage(session, text);
      }
      const praticienDemande = matchPraticien(text);
      if (praticienDemande) session.praticienId = praticienDemande;
      if (parseNegative(text) || parseWantsSomethingElse(text)) {
        Object.assign(session, freshSession());
        session.pretPourChoix = true;
        return "Pas de souci ! Quel service vous intéresse ? Nous proposons : " + state.services.map((s) => s.nom).join(", ") + ".";
      }
      const service = serviceActuel(session);
      return handleDateTimeAttempt(session, text, service);
    }

    if (session.stage === "awaiting_slot_choice") {
      const choisi = matchSlotChoice(text, session.proposedSlots);
      const service = serviceActuel(session);
      if (choisi) {
        return bookSlot(session, choisi, service, session.praticienId || choisirPraticienLibre(choisi, service.dureeMinutes));
      }
      if (parseNegative(text) || parseWantsSomethingElse(text)) {
        Object.assign(session, freshSession());
        session.pretPourChoix = true;
        return "Pas de souci ! Quel service vous intéresse ? Nous proposons : " + state.services.map((s) => s.nom).join(", ") + ".";
      }
      const autresServices = matchServicesMultiple(text);
      const memeService = autresServices.length && autresServices.slice().sort().join("+") === (session.serviceIds || []).slice().sort().join("+");
      if (autresServices.length && !memeService) {
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

      const service = serviceActuel(session);
      const slotStart = new Date(session.pendingSlotISO);
      if (!isSlotFreePour(slotStart, service.dureeMinutes, session.pendingPraticienId)) {
        // Un autre client a pris ce creneau entre-temps (course tres rare mais possible) : on repropose.
        session.pendingSlotISO = null;
        return handleDateTimeAttempt(session, "", service) || "Ce créneau vient d'être pris par quelqu'un d'autre, quel autre jour/heure vous conviendrait ?";
      }
      const appt = createAppointment(session, slotStart, service);
      session.pendingAppointmentId = appt.id;
      session.stage = "awaiting_confirmation";
      return piocheParmi(OUVERTURES_RECAP) + " Voici le récapitulatif de votre rendez-vous (" + orderRef(appt) + ") :\n" +
        "• " + service.nom + " — " + formatSlot(slotStart) + " — " + formatFcfa(service.prix) + (appt.praticienNom ? " — avec " + appt.praticienNom : "") + "\n" +
        "Au nom de : " + session.clientNom + "\n\nConfirmez-vous ce rendez-vous ? (oui / non)";
    }

    if (session.stage === "awaiting_confirmation") {
      const appt = state.appointments.filter((a) => a.id === session.pendingAppointmentId)[0];
      if (appt && parseAffirmative(text)) {
        applyStatusChange(appt, "Confirmé");
        notifierMarchand("rdv_confirme", [
          orderRef(appt),
          appt.service + (appt.praticienNom ? " (avec " + appt.praticienNom + ")" : ""),
          formatSlot(new Date(appt.dateISO)),
          formatFcfa(appt.prix),
          appt.clientNom || "—",
          appt.telephone || session.fromPhone || "—"
        ]).catch((erreur) =>
          console.error("[" + merchantKey + "] Echec de la notification marchand (rendez-vous confirmé) :", erreur)
        );
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

    // Etat "idle" : on essaie de reconnaitre le(s) service(s) demande(s), et au passage un praticien
    // demande explicitement (ex: "coupe avec Sandra jeudi") - voir matchServicesMultiple()/matchPraticien().
    const serviceIds = matchServicesMultiple(text);
    if (!serviceIds.length) {
      session.pretPourChoix = true;
      return "Bonjour ! Quel service vous intéresse ? Nous proposons : " + state.services.map((s) => s.nom).join(", ") + ".";
    }
    session.serviceIds = serviceIds;
    session.serviceId = serviceIds.join("+");
    const praticienDemande = matchPraticien(text);
    if (praticienDemande) session.praticienId = praticienDemande;
    const service = combinerServices(serviceIds);
    // Le petit mot gentil sort a chaque fois que le service vient d'etre reconnu dans CE message (ici
    // toujours vrai, puisqu'on entre dans ce bloc seulement depuis l'etat "idle"), pas a chaque relance
    // ensuite - meme regle que dans le moteur catalogue.
    return piocheParmi(OUVERTURES_SERVICE) + " " + handleDateTimeAttempt(session, text, service);
  }

  // ---------------- Annulation / report en libre-service (voir sh.detecterIntentionRdv) ----------------
  // Reconnu a n'importe quel moment de la conversation (comme la demande d'un humain), pas seulement dans
  // un stage dedie - un client qui ecrit "je veux annuler mon rendez-vous" du jour au lendemain, sans etre
  // en train de reserver, doit pouvoir le faire directement.

  function gererAnnulationOuReport(session, intention) {
    const maintenant = new Date();
    const prochains = state.appointments
      .filter((a) => a.fromWhatsapp === session.fromPhone && RESERVING_STATUSES_RDV.indexOf(a.statut) !== -1 && new Date(a.dateISO) > maintenant)
      .sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
    const appt = prochains[0];
    if (!appt) {
      return "Je ne trouve pas de rendez-vous à venir associé à ce numéro. Souhaitez-vous en prendre un nouveau ? Quel service vous intéresse ?";
    }

    if (intention === "annuler") {
      applyStatusChange(appt, "Annulé", "Annulé par le client via WhatsApp");
      Object.assign(session, freshSession());
      return "Votre rendez-vous " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO)) + ") est annulé. N'hésitez pas à revenir si vous souhaitez reprendre un rendez-vous.";
    }

    // "reporter" : on libere l'ancien creneau et on relance immediatement la prise de rendez-vous pour le
    // meme service (et le meme praticien si un etait assigne), sans faire retaper le service au client.
    applyStatusChange(appt, "Annulé", "Reporté par le client via WhatsApp");
    const service = combinerServices(String(appt.serviceId || "").split("+")) || state.services.filter((s) => s.id === appt.serviceId)[0];
    Object.assign(session, freshSession());
    if (!service) {
      session.pretPourChoix = true;
      return "Votre ancien rendez-vous est annulé. Quel service souhaitez-vous pour le nouveau rendez-vous ? Nous proposons : " + state.services.map((s) => s.nom).join(", ") + ".";
    }
    session.serviceIds = service.combo || [service.id];
    session.serviceId = session.serviceIds.join("+");
    if (appt.praticienId) session.praticienId = appt.praticienId;
    return "Votre ancien rendez-vous est annulé. " + handleDateTimeAttempt(session, "", service);
  }

  function handleMessage(fromPhone, text) {
    if (!state) return "Le service redemarre, un instant s'il vous plait...";

    journaliser(fromPhone, "client", text);

    if (sh.pauseHumainActive(conversationsHumain, fromPhone)) {
      sh.ajouterMessageHistorique(conversationsHumain, fromPhone, "client", text);
      return null;
    }

    if (sh.demandeUnHumain(text)) {
      sh.demarrerPauseHumain(conversationsHumain, fromPhone, text);
      notifierMarchand("humain", [fromPhone, text]).catch((erreur) =>
        console.error("[" + merchantKey + "] Echec de la notification marchand (humain) :", erreur)
      );
      journaliser(fromPhone, "bot", sh.MESSAGE_MISE_EN_RELATION);
      return sh.MESSAGE_MISE_EN_RELATION;
    }

    // Premier contact JAMAIS vu de ce numero (avant que getSession() ne cree sa session) : on glissera la
    // mention du conseiller humain disponible a la reponse qui suit, une seule fois.
    const estPremierContact = !sessions[fromPhone] && !humanHintDonne[fromPhone];
    const session = getSession(fromPhone);

    const intentionRdv = sh.detecterIntentionRdv(text);
    let reponse = intentionRdv ? gererAnnulationOuReport(session, intentionRdv) : processMessage(session, text);

    if (estPremierContact && reponse) {
      humanHintDonne[fromPhone] = true;
      reponse += sh.MENTION_HUMAIN_DISPONIBLE;
    }
    journaliser(fromPhone, "bot", reponse);
    return reponse;
  }

  function getConversationsEnAttente() {
    return sh.listerConversationsEnAttente(conversationsHumain);
  }

  async function repondreConversationHumain(telephone, message) {
    const ok = sh.repondreHumain(conversationsHumain, telephone, message);
    if (!ok) return false;
    await envoyer(telephone, message);
    journaliser(telephone, "marchand", message);
    return true;
  }

  // Etat courant de la session d'UN client (apres traitement de son dernier message) - utilise par
  // server.js pour decider s'il faut accompagner la reponse texte d'un menu WhatsApp cliquable (liste de
  // services, boutons Oui/Non, ou boutons des creneaux proposes), sans rien changer a handleMessage().
  function getEtatSession(fromPhone) {
    const s = sessions[fromPhone];
    return s ? { stage: s.stage, pretPourChoix: !!s.pretPourChoix, proposedSlots: s.proposedSlots || null } : null;
  }

  // Ne renvoie jamais les rendez-vous crees par le Simulateur (source:"simulateur") — invisibles dans la
  // vraie liste de rendez-vous du marchand et exclus du tableau de bord.
  function getAppointments() {
    if (!state) return [];
    return state.appointments.filter((a) => a.source !== "simulateur");
  }
  function getServices() { return state ? state.services : []; }
  function getSettings() { return state ? state.settings : {}; }

  // ---------------- Rappel automatique la veille (voir server.js, appele periodiquement) ----------------
  // Best-effort, dans le meme esprit que journaliser()/notifierMarchand() : un echec d'envoi ne doit
  // jamais faire planter le cycle, et n'est jamais reessaye (rappelEnvoye est marque avant l'envoi, comme
  // le reste du code de ce fichier qui privilegie ne-jamais-bloquer a la garantie de livraison).
  async function envoyerRappelsDuJour() {
    if (!state) return;
    const maintenant = Date.now();
    const dus = state.appointments.filter((a) => {
      if (a.source === "simulateur") return false;
      if (a.statut !== "Confirmé") return false;
      if (a.rappelEnvoye) return false;
      const delta = new Date(a.dateISO).getTime() - maintenant;
      return delta >= RAPPEL_DELAI_MIN_MS && delta < RAPPEL_DELAI_MAX_MS;
    });
    if (!dus.length) return;
    for (const a of dus) {
      a.rappelEnvoye = true;
      const texte = "Petit rappel 🙏 Vous avez rendez-vous " + formatSlot(new Date(a.dateISO)) + " pour " + a.service +
        (a.praticienNom ? " avec " + a.praticienNom : "") + ". À bientôt !\n\n" +
        "(Besoin de reporter ou d'annuler ? Écrivez-le-moi directement ici.)";
      try {
        await envoyer(a.fromWhatsapp || a.telephone, texte);
        journaliser(a.fromWhatsapp || a.telephone, "bot", texte);
      } catch (erreur) {
        console.error("[" + merchantKey + "] Echec de l'envoi du rappel pour " + orderRef(a) + " :", erreur);
      }
    }
    saveState();
  }

  // ---------------- Simulateur WhatsApp (onglet /admin, teste le VRAI moteur sans toucher aux vraies
  // donnees). Contrairement au moteur catalogue, ce moteur n'a pas (encore) de panneau de trace/analyse
  // detaille : `trace` reste toujours null ici, /admin masque simplement ce panneau pour un marchand
  // service.
  function handleMessageSimulateur(text) {
    const reponse = handleMessage(PHONE_SIMULATEUR, text);
    return { reponse, trace: null };
  }

  function resetSimulateur() {
    delete sessions[PHONE_SIMULATEUR];
    delete conversationsHumain[PHONE_SIMULATEUR];
    delete humanHintDonne[PHONE_SIMULATEUR];
    if (state) {
      const avant = state.appointments.length;
      state.appointments = state.appointments.filter((a) => a.fromWhatsapp !== PHONE_SIMULATEUR);
      if (state.appointments.length !== avant) saveState();
    }
  }

  // ---------------- Tableau de bord (adapte aux rendez-vous) ----------------

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // Memes regles que conversation.js (moteur catalogue) pour le selecteur de periode du Tableau de bord -
  // dupliquees ici car les deux moteurs restent independants (voir commentaire en tete de fichier).
  function debutPeriode(periode, dateReference) {
    const d = new Date(dateReference);
    if (periode === "semaine") {
      const jourSemaine = (d.getDay() + 6) % 7; // 0 = lundi
      d.setDate(d.getDate() - jourSemaine);
    } else if (periode === "mois") {
      d.setDate(1);
    } else if (periode === "trimestre") {
      d.setDate(1);
      d.setMonth(Math.floor(d.getMonth() / 3) * 3);
    } else if (periode === "annee") {
      d.setDate(1);
      d.setMonth(0);
    }
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function finPeriode(periode, debut) {
    const f = new Date(debut);
    if (periode === "jour") f.setDate(f.getDate() + 1);
    else if (periode === "semaine") f.setDate(f.getDate() + 7);
    else if (periode === "trimestre") f.setMonth(f.getMonth() + 3);
    else if (periode === "annee") f.setFullYear(f.getFullYear() + 1);
    else f.setMonth(f.getMonth() + 1); // "mois" (et repli par defaut)
    return f;
  }

  // `periode`/`dateReference` : voir le commentaire equivalent dans conversation.js. Les prochains RDV
  // (a venir) et le sparkline 7 jours restent independants de la periode choisie.
  function getTableauDeBord(opts) {
    if (!state) return null;
    const periode = (opts && opts.periode) || "jour";
    const dateReference = (opts && opts.dateReference) || new Date();
    const debut = debutPeriode(periode, dateReference);
    const fin = finPeriode(periode, debut);

    const toutes = getAppointments();
    const actives = toutes.filter((a) => a.statut !== "Annulé");
    const dansPeriode = actives.filter((a) => {
      const d = new Date(a.createdAtISO || a.dateISO);
      return d >= debut && d < fin;
    });

    const now = new Date();
    const dans7Jours = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const prochainsRdv = actives
      .filter((a) => (a.statut === "Nouvelle" || a.statut === "Confirmé") && new Date(a.dateISO) >= now && new Date(a.dateISO) <= dans7Jours)
      .sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO))
      .slice(0, 10)
      .map((a) => ({ reference: "RDV-" + String(a.id).padStart(4, "0"), service: a.service, clientNom: a.clientNom, dateISO: a.dateISO, statut: a.statut, praticienNom: a.praticienNom || null }));

    const sparkline7j = [];
    for (let d = 6; d >= 0; d--) {
      const jour = new Date();
      jour.setDate(jour.getDate() - d);
      sparkline7j.push(actives.filter((a) => sameDay(new Date(a.createdAtISO || a.dateISO), jour)).length);
    }

    const compteurs = {};
    dansPeriode.forEach((a) => { compteurs[a.service] = (compteurs[a.service] || 0) + 1; });
    const topServices = Object.keys(compteurs)
      .map((nom) => ({ nom, quantite: compteurs[nom] }))
      .sort((a, b) => b.quantite - a.quantite)
      .slice(0, 4);

    return {
      periode,
      debutISO: debut.toISOString(),
      finISO: fin.toISOString(),
      commandesPeriode: dansPeriode.length,
      caPeriode: dansPeriode.reduce((s, a) => s + (a.prix || 0), 0),
      alertesStock: 0,
      ruptures: 0,
      conversationsEnAttente: sh.listerConversationsEnAttente(conversationsHumain).length,
      sparkline7j,
      topProduits: topServices,
      prochainsRendezVous: prochainsRdv
    };
  }

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
    updateAppointmentStatus,
    getConversationsEnAttente,
    repondreConversationHumain,
    getEtatSession,
    handleMessageSimulateur,
    resetSimulateur,
    getTableauDeBord,
    envoyerRappelsDuJour
  };
}

module.exports = createServiceEngine;
