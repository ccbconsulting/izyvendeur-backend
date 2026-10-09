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

const STOPWORDS = ["de", "du", "des", "la", "le", "les", "en", "à", "au", "aux", "et", "un", "une", "pour", "avec", "and", "the", "with", "for", "of"];
const DAY_KEYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
// Bilingue (Etape 45) : noms de jours/mois en anglais (meme ordre que DAY_KEYS : 0 = dimanche).
const DAY_KEYS_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MOIS_COURTS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Message de confirmation par defaut en anglais (le defaut francais, lui, vient de services.js) - utilise
// seulement si le marchand n'a pas rempli le champ "message de confirmation - English" (Parametres).
const DEFAULT_AUTO_CONFIRM_MESSAGE_EN = "Your appointment is confirmed ✅ Thank you, and see you soon!";

// Synonymes anglais des services les plus courants (salons, instituts, cliniques, garages...) : un client
// qui ecrit "haircut" doit retrouver le service "Coupe" meme si le marchand l'a nomme en francais. Cle = mot
// francais SANS accent present dans le nom du service ; valeur = termes anglais equivalents a reconnaitre.
// Volontairement code ici (et pas dans services.js, qui varie d'un deploiement a l'autre).
const SYNONYMES_SERVICE_EN = {
  "coupe": ["haircut", "hair cut", "cut", "trim"],
  "brushing": ["blow dry", "blowdry", "blow-dry"],
  "manucure": ["manicure", "nails", "nail"],
  "pedicure": ["pedicure", "pedi"],
  "vernis": ["nail polish", "polish"],
  "pose": ["installation", "fitting"],
  "soin": ["treatment", "care"],
  "visage": ["facial", "face"],
  "massage": ["massage"],
  "epilation": ["waxing", "hair removal"],
  "maquillage": ["makeup", "make-up", "make up"],
  "coloration": ["hair color", "hair colour", "coloring", "colouring", "dye", "color", "colour"],
  "lissage": ["straightening", "hair straightening"],
  "tresse": ["braids", "braid", "braiding"],
  "tresses": ["braids", "braid", "braiding"],
  "tissage": ["weave", "sew-in", "sew in"],
  "perruque": ["wig"],
  "extension": ["extensions", "hair extensions"],
  "barbe": ["beard", "beard trim"],
  "rasage": ["shave", "shaving"],
  "consultation": ["consultation", "consult", "check-up", "checkup", "doctor visit"],
  "controle": ["check-up", "checkup", "check up", "inspection"],
  "detartrage": ["scaling", "teeth cleaning", "dental cleaning"],
  "vidange": ["oil change"],
  "revision": ["service", "maintenance", "servicing"],
  "diagnostic": ["diagnostic", "diagnosis"],
  "reparation": ["repair"],
  "lavage": ["wash", "car wash"],
  "bilan": ["assessment", "check-up", "checkup"],
  "seance": ["session"],
  "coiffure": ["hairstyle", "hairdo", "hair styling", "hairdressing"],
  "defrisage": ["relaxer", "relaxing"],
  "shampoing": ["shampoo", "hair wash"]
};

function sansAccents(texte) {
  return String(texte || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Delai maximal/minimal des rappels et reessais (voir envoyerRappelsDuJour plus bas).

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
// Etape 44 - fiabilite des rappels : un envoi qui echoue (le plus souvent : texte libre refuse par WhatsApp
// hors de la fenetre de 24 h avec le client, ou token expire) est REESSAYE jusqu'a RAPPEL_MAX_TENTATIVES
// fois, avec une attente croissante entre deux essais (RAPPEL_ATTENTES_MS, indexee par le nombre d'essais
// deja faits), et plus du tout dans les RAPPEL_MARGE_MIN_MS qui precedent le rendez-vous (un rappel recu 30
// minutes avant n'a plus d'utilite). Au-dela, l'echec reste visible dans /admin > Rendez-vous.
const RAPPEL_MAX_TENTATIVES = 4;
const RAPPEL_ATTENTES_MS = [30 * 60 * 1000, 2 * 3600 * 1000, 4 * 3600 * 1000];
const RAPPEL_MARGE_MIN_MS = 2 * 3600 * 1000;

const OUVERTURES_SERVICE = ["Excellent choix !", "Très bon choix !", "Parfait !", "Belle sélection !"];
const OUVERTURES_SERVICE_EN = ["Excellent choice!", "Great choice!", "Perfect!", "Lovely pick!"];
const OUVERTURES_CRENEAU = ["Parfait,", "Très bien,", "Super,", "Excellente nouvelle,"];
const OUVERTURES_CRENEAU_EN = ["Perfect,", "Great,", "Sure,", "Good news,"];
const OUVERTURES_RECAP = ["Très bien !", "Parfait, on y est presque !", "Super !"];
const OUVERTURES_RECAP_EN = ["Great!", "Perfect, almost there!", "Super!"];

// Tire une ouverture aleatoire dans la langue de la session (meme principe que conversation.js).
function ouverture(session, poolFr, poolEn) {
  return piocheParmi(sh.t(session, poolFr, poolEn));
}

function seedState() {
  return {
    services: JSON.parse(JSON.stringify(SEED_SERVICES)),
    appointments: [],
    nextId: 1,
    settings: {
      horaires: JSON.parse(JSON.stringify(DEFAULT_HORAIRES)),
      dureeCreneauMinutes: DEFAULT_DUREE_CRENEAU_MINUTES,
      autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE,
      autoConfirmMessageEn: "",
      // Fuseau horaire du marchand (Etape 44) : toutes les heures de rendez-vous s'entendent dans ce
      // fuseau, jamais dans celui du serveur. `fuseauMigre` marque que les rendez-vous de cet etat ont
      // deja ete (re)interpretes dans ce fuseau - voir migrerFuseauRendezvous().
      fuseau: sh.FUSEAU_PAR_DEFAUT,
      fuseauMigre: new Date().toISOString(),
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
  // Etape 44 : envoi d'un RAPPEL de rendez-vous au client. Contrairement a `envoyer` (qui ne signale jamais
  // un refus de WhatsApp), `options.envoyerRappel(telephone, texteLibre, { langue, parametres })` renvoie
  // { ok, canal, erreur } : texte libre d'abord (gratuit, mais refuse par WhatsApp hors de la fenetre de 24 h
  // avec le client), puis repli sur un template approuve - voir server.js (creerOptionsEngine). Sans cette
  // option (tests, ancien appelant), on se rabat sur `envoyer` : une exception = echec, sinon succes.
  const envoyerRappelOption = (options && options.envoyerRappel) || (async (telephone, texte) => {
    await envoyer(telephone, texte);
    return { ok: true, canal: "texte" };
  });
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
    if (typeof state.settings.autoConfirmMessageEn !== "string") state.settings.autoConfirmMessageEn = "";
    if (!Array.isArray(state.settings.praticiens)) state.settings.praticiens = [];
    if (!state.appointments) state.appointments = [];
    if (!sh.fuseauValide(state.settings.fuseau)) state.settings.fuseau = sh.FUSEAU_PAR_DEFAUT;
    migrerFuseauRendezvous();
  }

  // ---------------- Fuseau horaire (Etape 44) ----------------
  // Avant l'Etape 44, "10h" tape par un client etait converti avec le fuseau du SERVEUR (setHours) : sur
  // Render (UTC) le creneau etait donc enregistre a 10:00 UTC = 11h a Douala, alors que le client avait lu
  // "10h". Les rendez-vous deja enregistres portent cette erreur. Migration unique (marquee par
  // settings.fuseauMigre) : on relit chaque dateISO existante avec l'horloge du serveur (celle qui avait
  // servi a la fabriquer) et on la reconvertit dans le fuseau du marchand - l'heure que le client a lue
  // ("10h") est donc conservee. Sans effet si le serveur tournait deja dans le meme fuseau.
  function migrerFuseauRendezvous() {
    if (state.settings.fuseauMigre) return;
    const tz = fz();
    let modifies = 0;
    (state.appointments || []).forEach((a) => {
      const d = new Date(a.dateISO);
      if (isNaN(d.getTime())) return;
      const corrige = sh.dateDepuisPartiesFuseau(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), tz);
      if (corrige.getTime() !== d.getTime()) { a.dateISO = corrige.toISOString(); modifies++; }
    });
    state.settings.fuseauMigre = new Date().toISOString();
    if (modifies) console.log("[" + merchantKey + "] Fuseau " + tz + " : " + modifies + " rendez-vous re-interprete(s) (migration unique de l'Etape 44).");
    saveState();
  }

  // Fuseau effectif du marchand (jamais celui du serveur).
  function fz() {
    return (state && state.settings && sh.fuseauValide(state.settings.fuseau) && state.settings.fuseau) || sh.FUSEAU_PAR_DEFAUT;
  }

  function saveState() {
    if (!state) return;
    db.persistMerchantState(merchantKey, state).catch((erreur) => {
      console.error("[" + merchantKey + "] Erreur de sauvegarde de l'etat (la derniere modification pourrait etre perdue au redemarrage) :", erreur);
    });
  }

  // `precedente` (optionnel) : session existante dont on conserve la langue deja choisie - un client qui
  // vient de reserver (ou d'annuler) ne doit jamais se refaire redemander FR/EN. Voir resetSession().
  function freshSession(precedente) {
    return {
      langue: precedente ? precedente.langue : null,
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

  // Remet une session a zero (nouvelle reservation) en CONSERVANT la langue choisie.
  function resetSession(session) {
    Object.assign(session, freshSession(session));
    session.pendingSlotISO = null;
    return session;
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
      // Synonymes anglais (Etape 45) : un mot-cle francais present dans le nom du service (compare sans
      // accents) ajoute ses equivalents anglais ; `nomEn` (facultatif, si le service en porte un) aussi.
      const motsSansAccents = sansAccents(s.nom).split(/[^a-z0-9]+/).filter(Boolean);
      const synonymesEn = [];
      motsSansAccents.forEach((m) => { if (SYNONYMES_SERVICE_EN[m]) SYNONYMES_SERVICE_EN[m].forEach((x) => synonymesEn.push(x)); });
      if (s.nomEn) synonymesEn.push(String(s.nomEn).toLowerCase());
      const keywords = [s.nom.toLowerCase()].concat(extra, nameWords, synonymesEn).filter((v, i, a) => a.indexOf(v) === i);
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
    const segments = text.split(/\bet\b|\band\b|\+|,|\bavec\b|\bwith\b/i).map((s) => s.trim()).filter(Boolean);
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

  // Toutes les fonctions de date ci-dessous raisonnent en heure MURALE du fuseau du marchand (voir fz() et
  // shared.js) - jamais getHours()/setHours()/getDay(), qui dependent du fuseau du serveur. Un "jour" est
  // represente par l'instant de son minuit dans ce fuseau.
  function startOfDay(d) { return sh.debutJourFuseau(d, fz()); }
  function ajouterJours(d, n) { return sh.ajouterJoursFuseau(d, n, fz()); }
  function jourSemaine(d) { return sh.partiesFuseau(d, fz()).jourSemaine; }

  function parseRequestedDate(text, now) {
    const t = text.toLowerCase();
    if (/\bapr[eè]s[- ]?demain\b/.test(t) || /\bday after tomorrow\b/.test(t)) return ajouterJours(startOfDay(now), 2);
    if (/\bdemain\b/.test(t) || /\btomorrow\b/.test(t)) return ajouterJours(startOfDay(now), 1);
    if (/\baujourd['’]?hui\b/.test(t) || /\btoday\b/.test(t)) return startOfDay(now);
    for (let i = 0; i < DAY_KEYS.length; i++) {
      const re = new RegExp("\\b(?:" + DAY_KEYS[i] + "|" + DAY_KEYS_EN[i] + ")\\b", "i");
      if (re.test(t)) {
        const veutSemaineProchaine = /\b(?:prochain[e]?|next)\b/.test(t);
        const todayIdx = jourSemaine(now);
        let delta = (i - todayIdx + 7) % 7;
        if (delta === 0 && veutSemaineProchaine) delta = 7;
        return ajouterJours(startOfDay(now), delta);
      }
    }
    return null;
  }

  // Renvoie { h, m } (heure murale, sans date) - a recombiner avec un jour par l'appelant (composer()).
  // Francais : "10h", "10h30", "10:30" ; anglais : "10am", "2:30 pm", "noon" ; "midi" dans les deux langues.
  function parseRequestedTime(text) {
    const t = text.toLowerCase();
    const ampm = t.match(/\b(\d{1,2})(?:[:.h](\d{2}))?\s*([ap])\.?\s?m\b\.?/);
    if (ampm) {
      let heure = parseInt(ampm[1], 10);
      const minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
      if (heure >= 1 && heure <= 12 && minute >= 0 && minute < 60) {
        if (ampm[3] === "p" && heure < 12) heure += 12;
        if (ampm[3] === "a" && heure === 12) heure = 0;
        return { h: heure, m: minute };
      }
    }
    const m = t.match(/\b(\d{1,2})\s*[h:]\s*(\d{2})?\b/);
    if (m) {
      let heure = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      // Heuristique : dans ce contexte commercial (horaires typiques 8h-18h), "3h" ou "5h" tout seuls
      // designent presque toujours l'apres-midi plutot que le petit matin - on privilegie cette lecture.
      if (heure >= 1 && heure <= 7) heure += 12;
      if (heure >= 0 && heure <= 23 && minute >= 0 && minute < 60) return { h: heure, m: minute };
    }
    if (/\b(?:midi|noon)\b/.test(t)) return { h: 12, m: 0 };
    return null;
  }

  // Instant correspondant a l'heure murale h:m du jour (dans le fuseau du marchand) represente par dateOnly.
  function composer(dateOnly, h, m) {
    const p = sh.partiesFuseau(dateOnly, fz());
    return sh.dateDepuisPartiesFuseau(p.annee, p.mois, p.jour, h, m, fz());
  }

  function combineDateHeure(dateOnly, heureRef) {
    return composer(dateOnly, heureRef.h, heureRef.m);
  }

  function combineDateHeureStr(dateOnly, hhmm) {
    const parts = String(hhmm || "00:00").split(":");
    return composer(dateOnly, parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0);
  }

  // ---------------- Disponibilite ----------------

  function horaireDuJour(dateOnly) {
    return (state.settings.horaires || {})[DAY_KEYS[jourSemaine(dateOnly)]];
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
      cursor = ajouterJours(cursor, 1);
    }
    return out;
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // "Lundi 12/10 à 10h30" (francais, format historique) / "Monday 12 Oct at 10:30 AM" (anglais) - toujours
  // l'heure murale du fuseau du marchand. `session` null/sans langue = francais (cote marchand, par exemple).
  function formatSlot(d, session) {
    const p = sh.partiesFuseau(d, fz());
    const hh = String(p.heure).padStart(2, "0");
    const mi = String(p.minute).padStart(2, "0");
    if (sh.langueSession(session) === "en") {
      const h12 = p.heure % 12 === 0 ? 12 : p.heure % 12;
      return capitalize(DAY_KEYS_EN[p.jourSemaine]) + " " + p.jour + " " + MOIS_COURTS_EN[p.mois - 1] + " at " + h12 + ":" + mi + " " + (p.heure < 12 ? "AM" : "PM");
    }
    const jj = String(p.jour).padStart(2, "0");
    const mm = String(p.mois).padStart(2, "0");
    return capitalize(DAY_KEYS[p.jourSemaine]) + " " + jj + "/" + mm + " à " + hh + "h" + (mi === "00" ? "" : mi);
  }

  // Libelle COURT (20 caracteres max) d'un creneau pour un bouton WhatsApp - voir getEtatSession().
  function libelleCourtCreneau(d, session) {
    const p = sh.partiesFuseau(d, fz());
    const mi = String(p.minute).padStart(2, "0");
    if (sh.langueSession(session) === "en") {
      const h12 = p.heure % 12 === 0 ? 12 : p.heure % 12;
      return capitalize(DAY_KEYS_EN[p.jourSemaine]).slice(0, 3) + " " + p.jour + " " + MOIS_COURTS_EN[p.mois - 1] + " " + h12 + ":" + mi + (p.heure < 12 ? "a" : "p");
    }
    return capitalize(DAY_KEYS[p.jourSemaine]).slice(0, 3) + " " + String(p.jour).padStart(2, "0") + "/" + String(p.mois).padStart(2, "0") + " " + p.heure + "h" + (mi === "00" ? "" : mi);
  }

  function matchSlotChoice(text, proposedSlots) {
    if (!proposedSlots || !proposedSlots.length) return null;
    // Normalise ("the first one", "le premier", "2nd please"...) avant de chercher un ordinal.
    const t = sansAccents(text).trim().replace(/^(?:le|la|the)\s+/, "").replace(/\s+(?:one|please|svp|stp)\s*$/, "").trim();
    const heure = parseRequestedTime(text);
    if (heure) {
      const match = proposedSlots.filter((s) => {
        const p = sh.partiesFuseau(s, fz());
        return p.heure === heure.h && p.minute === heure.m;
      })[0];
      if (match) return match;
    }
    const ordinalMap = {
      "1": 0, "premier": 0, "un": 0, "first": 0, "1st": 0, "one": 0,
      "2": 1, "deuxieme": 1, "2eme": 1, "second": 1, "2nd": 1, "two": 1,
      "3": 2, "troisieme": 2, "3eme": 2, "third": 2, "3rd": 2, "three": 2
    };
    if (Object.prototype.hasOwnProperty.call(ordinalMap, t) && proposedSlots[ordinalMap[t]]) return proposedSlots[ordinalMap[t]];
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
      // Langue de la conversation (Etape 45) : le rappel automatique est envoye dans cette langue.
      langue: sh.langueSession(session),
      // Rappel automatique la veille (voir envoyerRappelsDuJour) - `rappelEnvoye` ne passe a true qu'une
      // fois le message REELLEMENT livre a WhatsApp (Etape 44) ; rappelTentatives/rappelErreur/
      // rappelProchaineTentativeISO/rappelCanal documentent les essais.
      rappelEnvoye: false,
      rappelTentatives: 0,
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
      return sh.t(session,
        "Quel jour et à quelle heure vous conviendrait pour votre " + service.nom + " ?",
        "Which day and what time would suit you for your " + service.nom + "?"
      );
    }

    let dateOnly = dateDemandee || startOfDay(now);
    if (!dateDemandee && heureDemandee) {
      // Heure seule, sans jour : on suppose aujourd'hui si le creneau n'est pas deja passe, sinon demain.
      const essai = combineDateHeure(dateOnly, heureDemandee);
      if (essai.getTime() <= now.getTime()) dateOnly = ajouterJours(startOfDay(now), 1);
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
      alternatives = nextAvailableFrom(ajouterJours(dateOnly, 1), service.dureeMinutes, now, 3, praticienId);
      messagePrefixe = sh.t(session, "Désolée, plus aucune place ce jour-là 😕 ", "Sorry, there is nothing left that day 😕 ");
    } else if (heureDemandee) {
      messagePrefixe = sh.t(session, "Ce créneau n'est pas disponible. ", "That time slot isn't available. ");
    }

    if (!alternatives.length) {
      session.stage = "awaiting_datetime";
      return messagePrefixe + sh.t(session,
        "Je ne trouve pas de créneau disponible dans les prochains jours pour " + service.nom + ". Quel autre jour souhaitez-vous essayer ?",
        "I can't find an available slot in the coming days for " + service.nom + ". Which other day would you like to try?"
      );
    }

    session.proposedSlots = alternatives;
    session.stage = "awaiting_slot_choice";
    const liste = alternatives.map((s, i) => (i + 1) + ". " + formatSlot(s, session)).join("\n");
    return messagePrefixe + ouverture(session, OUVERTURES_CRENEAU, OUVERTURES_CRENEAU_EN) + sh.t(session,
      " voici les prochaines disponibilités pour " + service.nom + " :\n" + liste + "\n\nLequel vous convient ? (répondez par l'heure ou le numéro)",
      " here are the next available times for " + service.nom + ":\n" + liste + "\n\nWhich one suits you? (reply with the time or the number)"
    );
  }

  function bookSlot(session, slotStart, service, praticienId) {
    session.pendingSlotISO = slotStart.toISOString();
    session.pendingPraticienId = praticienId || null;
    session.stage = "awaiting_client_name";
    // Le nom du praticien n'apparait que si le marchand en a configure plusieurs - pour un seul (ou aucun
    // configure), la mention serait un bruit inutile puisque le client n'a de toute facon aucun choix.
    const nomPraticien = getPraticiens().length > 1 ? praticienNomParId(praticienId) : null;
    const mentionPraticien = nomPraticien ? sh.t(session, " avec " + nomPraticien, " with " + nomPraticien) : "";
    return ouverture(session, OUVERTURES_CRENEAU, OUVERTURES_CRENEAU_EN) + sh.t(session,
      " le " + formatSlot(slotStart, session) + " est disponible pour " + service.nom + mentionPraticien + " (" + formatFcfa(service.prix) + "). À quel nom dois-je noter ce rendez-vous ?",
      " " + formatSlot(slotStart, session) + " is available for " + service.nom + mentionPraticien + " (" + formatFcfa(service.prix) + "). What name should I put this appointment under?"
    );
  }

  function listeServicesTexte() { return state.services.map((s) => s.nom).join(", "); }

  function messageChoixService(session, introFr, introEn) {
    return sh.t(session,
      introFr + " Nous proposons : " + listeServicesTexte() + ".",
      introEn + " We offer: " + listeServicesTexte() + "."
    );
  }

  function processMessage(session, text) {
    // Reinitialise a chaque tour - seuls les 3 points de retour "quel service vous interesse ?" plus bas
    // le repassent a true juste avant de renvoyer leur texte (voir freshSession() ci-dessus).
    session.pretPourChoix = false;

    if (session.stage === "awaiting_datetime") {
      const autresServices = matchServicesMultiple(text);
      const memeService = autresServices.length && autresServices.slice().sort().join("+") === (session.serviceIds || []).slice().sort().join("+");
      if (autresServices.length && !memeService) {
        resetSession(session);
        return processMessage(session, text);
      }
      const praticienDemande = matchPraticien(text);
      if (praticienDemande) session.praticienId = praticienDemande;
      if (parseNegative(text) || parseWantsSomethingElse(text)) {
        resetSession(session);
        session.pretPourChoix = true;
        return messageChoixService(session, "Pas de souci ! Quel service vous intéresse ?", "No problem! Which service are you interested in?");
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
        resetSession(session);
        session.pretPourChoix = true;
        return messageChoixService(session, "Pas de souci ! Quel service vous intéresse ?", "No problem! Which service are you interested in?");
      }
      const autresServices = matchServicesMultiple(text);
      const memeService = autresServices.length && autresServices.slice().sort().join("+") === (session.serviceIds || []).slice().sort().join("+");
      if (autresServices.length && !memeService) {
        resetSession(session);
        return processMessage(session, text);
      }
      // Le client tente peut-etre un autre jour/heure plutot que l'une des propositions - on retente.
      const nouvelleTentative = handleDateTimeAttempt(session, text, service);
      if (session.stage !== "awaiting_slot_choice" || session.proposedSlots) return nouvelleTentative;
      return sh.t(session,
        "Je n'ai pas compris votre choix. Répondez par l'heure souhaitée (ex : 10h) ou par son numéro (1, 2, 3).",
        "I didn't understand your choice. Reply with the time you'd like (e.g. 10am) or its number (1, 2, 3)."
      );
    }

    if (session.stage === "awaiting_client_name") {
      const nom = text.trim().slice(0, 80);
      if (!nom) return sh.t(session, "Merci d'indiquer le nom à noter pour ce rendez-vous.", "Please tell me the name to put this appointment under.");
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
        resetSession(session);
        return sh.t(session,
          "Vous avez déjà " + recentCount + " rendez-vous en attente de confirmation. Merci de confirmer ou d'annuler l'un d'entre eux avant d'en prendre un nouveau — notre équipe reste disponible si besoin.",
          "You already have " + recentCount + " appointments awaiting confirmation. Please confirm or cancel one of them before booking a new one — our team is available if you need help."
        );
      }

      const service = serviceActuel(session);
      const slotStart = new Date(session.pendingSlotISO);
      if (!isSlotFreePour(slotStart, service.dureeMinutes, session.pendingPraticienId)) {
        // Un autre client a pris ce creneau entre-temps (course tres rare mais possible) : on repropose.
        session.pendingSlotISO = null;
        return handleDateTimeAttempt(session, "", service) || sh.t(session,
          "Ce créneau vient d'être pris par quelqu'un d'autre, quel autre jour/heure vous conviendrait ?",
          "That slot has just been taken by someone else, which other day/time would suit you?"
        );
      }
      const appt = createAppointment(session, slotStart, service);
      session.pendingAppointmentId = appt.id;
      session.stage = "awaiting_confirmation";
      return ouverture(session, OUVERTURES_RECAP, OUVERTURES_RECAP_EN) + sh.t(session,
        " Voici le récapitulatif de votre rendez-vous (" + orderRef(appt) + ") :\n" +
          "• " + service.nom + " — " + formatSlot(slotStart, session) + " — " + formatFcfa(service.prix) + (appt.praticienNom ? " — avec " + appt.praticienNom : "") + "\n" +
          "Au nom de : " + session.clientNom + "\n\nConfirmez-vous ce rendez-vous ? (oui / non)",
        " Here is the summary of your appointment (" + orderRef(appt) + "):\n" +
          "• " + service.nom + " — " + formatSlot(slotStart, session) + " — " + formatFcfa(service.prix) + (appt.praticienNom ? " — with " + appt.praticienNom : "") + "\n" +
          "Under the name: " + session.clientNom + "\n\nDo you confirm this appointment? (yes / no)"
      );
    }

    if (session.stage === "awaiting_confirmation") {
      const appt = state.appointments.filter((a) => a.id === session.pendingAppointmentId)[0];
      if (appt && parseAffirmative(text)) {
        applyStatusChange(appt, "Confirmé");
        // Cote marchand : toujours en francais (comme les autres alertes), quelle que soit la langue du client.
        notifierMarchand("rdv_confirme", [
          orderRef(appt),
          appt.service + (appt.praticienNom ? " (avec " + appt.praticienNom + ")" : ""),
          formatSlot(new Date(appt.dateISO), null),
          formatFcfa(appt.prix),
          appt.clientNom || "—",
          appt.telephone || session.fromPhone || "—"
        ]).catch((erreur) =>
          console.error("[" + merchantKey + "] Echec de la notification marchand (rendez-vous confirmé) :", erreur)
        );
        // Message de confirmation redige par le marchand (champ anglais facultatif ; repli sur un defaut
        // DANS LA BONNE LANGUE plutot que d'imposer le francais du marchand a un client English).
        const reply = sh.langueSession(session) === "en"
          ? (state.settings && state.settings.autoConfirmMessageEn) || DEFAULT_AUTO_CONFIRM_MESSAGE_EN
          : (state.settings && state.settings.autoConfirmMessage) || DEFAULT_AUTO_CONFIRM_MESSAGE;
        resetSession(session);
        return reply;
      }
      if (appt && parseNegative(text)) {
        const reply = sh.t(session,
          "Très bien, votre rendez-vous reste enregistré. Notre équipe reviendra vers vous pour le confirmer.",
          "Alright, your appointment stays on record. Our team will get back to you to confirm it."
        );
        resetSession(session);
        return reply;
      }
      if (appt) {
        return sh.t(session,
          "Je n'ai pas bien compris. Confirmez-vous votre rendez-vous " + orderRef(appt) + " ? Répondez simplement par oui ou non — notre équipe reviendra vers vous pour toute autre question.",
          "I didn't quite get that. Do you confirm your appointment " + orderRef(appt) + "? Simply reply yes or no — our team will get back to you for anything else."
        );
      }
      const reply = sh.t(session, "Très bien, votre rendez-vous reste enregistré.", "Alright, your appointment stays on record.");
      resetSession(session);
      return reply;
    }

    // Etat "idle" : on essaie de reconnaitre le(s) service(s) demande(s), et au passage un praticien
    // demande explicitement (ex: "coupe avec Sandra jeudi") - voir matchServicesMultiple()/matchPraticien().
    const serviceIds = matchServicesMultiple(text);
    if (!serviceIds.length) {
      session.pretPourChoix = true;
      return messageChoixService(session, "Bonjour ! Quel service vous intéresse ?", "Hello! Which service are you interested in?");
    }
    session.serviceIds = serviceIds;
    session.serviceId = serviceIds.join("+");
    const praticienDemande = matchPraticien(text);
    if (praticienDemande) session.praticienId = praticienDemande;
    const service = combinerServices(serviceIds);
    // Le petit mot gentil sort a chaque fois que le service vient d'etre reconnu dans CE message (ici
    // toujours vrai, puisqu'on entre dans ce bloc seulement depuis l'etat "idle"), pas a chaque relance
    // ensuite - meme regle que dans le moteur catalogue.
    return ouverture(session, OUVERTURES_SERVICE, OUVERTURES_SERVICE_EN) + " " + handleDateTimeAttempt(session, text, service);
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
      return sh.t(session,
        "Je ne trouve pas de rendez-vous à venir associé à ce numéro. Souhaitez-vous en prendre un nouveau ? Quel service vous intéresse ?",
        "I can't find any upcoming appointment linked to this number. Would you like to book a new one? Which service are you interested in?"
      );
    }

    if (intention === "annuler") {
      applyStatusChange(appt, "Annulé", "Annulé par le client via WhatsApp");
      resetSession(session);
      return sh.t(session,
        "Votre rendez-vous " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + ") est annulé. N'hésitez pas à revenir si vous souhaitez reprendre un rendez-vous.",
        "Your appointment " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + ") has been cancelled. Feel free to come back if you'd like to book another one."
      );
    }

    // "reporter" : on libere l'ancien creneau et on relance immediatement la prise de rendez-vous pour le
    // meme service (et le meme praticien si un etait assigne), sans faire retaper le service au client.
    applyStatusChange(appt, "Annulé", "Reporté par le client via WhatsApp");
    const service = combinerServices(String(appt.serviceId || "").split("+")) || state.services.filter((s) => s.id === appt.serviceId)[0];
    resetSession(session);
    if (!service) {
      session.pretPourChoix = true;
      return messageChoixService(session,
        "Votre ancien rendez-vous est annulé. Quel service souhaitez-vous pour le nouveau rendez-vous ?",
        "Your previous appointment has been cancelled. Which service would you like for the new appointment?"
      );
    }
    session.serviceIds = service.combo || [service.id];
    session.serviceId = session.serviceIds.join("+");
    if (appt.praticienId) session.praticienId = appt.praticienId;
    return sh.t(session, "Votre ancien rendez-vous est annulé. ", "Your previous appointment has been cancelled. ") + handleDateTimeAttempt(session, "", service);
  }

  function handleMessage(fromPhone, text) {
    if (!state) return sh.t(sessions[fromPhone], "Le service redémarre, un instant s'il vous plaît...", "The service is restarting, one moment please...");

    journaliser(fromPhone, "client", text);

    // Reponse du client au choix "reponse ecrite ici" / "etre rappele(e)" (voir sh.messageChoixContact,
    // pose juste apres une demande d'humain ci-dessous) : verifiee AVANT pauseHumainActive() car la pause
    // demarre des la demande initiale (meme mecanisme unique pour les 2 cas, voir shared.js) - sans cette
    // priorite, ce message serait avale par la pause et le client n'aurait jamais de reponse.
    const sessionExistante = sessions[fromPhone];
    if (sessionExistante && sessionExistante.attenteChoixContactHumain) {
      sessionExistante.attenteChoixContactHumain = false;
      const veutAppel = sh.detecteChoixAppel(text);
      const texteOrigine = sessionExistante.texteDemandeHumainOrigine || text;
      delete sessionExistante.texteDemandeHumainOrigine;
      sh.ajouterMessageHistorique(conversationsHumain, fromPhone, "client", text);
      if (veutAppel) {
        // Deja alerte au moment de la demande initiale (texte d'origine) - on complete ici avec un second
        // message signalant la preference d'appel, sans jamais toucher au nombre de parametres du template
        // izyvendeur_alerte_humain deja approuve par Meta (voir sh.PREFIXE_PREFERENCE_APPEL).
        notifierMarchand("humain", [fromPhone, sh.PREFIXE_PREFERENCE_APPEL + texteOrigine]).catch((erreur) =>
          console.error("[" + merchantKey + "] Echec de la notification marchand (appel) :", erreur)
        );
      }
      const msgHumain = veutAppel ? sh.messageMiseEnRelationAppel(sessionExistante) : sh.messageMiseEnRelation(sessionExistante);
      journaliser(fromPhone, "bot", msgHumain);
      return msgHumain;
    }

    if (sh.pauseHumainActive(conversationsHumain, fromPhone)) {
      sh.ajouterMessageHistorique(conversationsHumain, fromPhone, "client", text);
      return null;
    }

    // Vient de reprendre la main automatiquement (delai de pause ecoule, voir sh.consommerSignalReprise) :
    // la reponse de ce tour-ci (quelle qu'elle soit plus bas) sera precedee d'une phrase de reprise
    // explicite plutot que de reprendre silencieusement, pour ne pas deconcerter le client.
    const reprisePauseHumain = sh.consommerSignalReprise(conversationsHumain, fromPhone);

    const session = getSession(fromPhone);

    // ---------------- Choix de langue (bilingue FR/EN, Etape 45) ----------------
    // Meme porte que le moteur catalogue (voir conversation.js) : le tout premier message d'un client recoit
    // la question "FR / EN" ; sa reponse fixe la langue pour la conversation et on retraite alors le texte
    // d'ORIGINE (ex. "coupe demain 10h" tape d'emblee) au lieu de le perdre derriere la porte. Le client peut
    // ensuite changer de langue a tout moment (sh.detecterChangementLangue).
    if (session.langue == null) {
      if (!session.gateLangueEnvoyee) {
        session.gateLangueEnvoyee = true;
        session.texteAvantLangue = text;
        const reponseGate = sh.messageChoixLangue();
        journaliser(fromPhone, "bot", reponseGate);
        return reponseGate;
      }
      session.langue = sh.detecterChoixLangueInitial(text) || "fr";
      if (session.texteAvantLangue) {
        text = session.texteAvantLangue;
        delete session.texteAvantLangue;
      }
    }

    const changementLangue = sh.detecterChangementLangue(text);
    if (changementLangue && changementLangue !== session.langue) {
      session.langue = changementLangue;
      let confirmationLangue = sh.t(session, "Très bien, je continue en français. 🇫🇷", "Sure, I'll continue in English. 🇬🇧");
      if (reprisePauseHumain) confirmationLangue = sh.messageReprisePause(session) + "\n\n" + confirmationLangue;
      journaliser(fromPhone, "bot", confirmationLangue);
      return confirmationLangue;
    }

    // Premiere reponse REELLE (ni la porte de langue ni une confirmation de langue) : on y glisse la mention
    // du conseiller humain disponible, une seule fois.
    const estPremierContact = !humanHintDonne[fromPhone];

    if (sh.demandeUnHumain(text)) {
      session.attenteChoixContactHumain = true;
      session.texteDemandeHumainOrigine = text;
      sh.demarrerPauseHumain(conversationsHumain, fromPhone, text);
      notifierMarchand("humain", [fromPhone, text]).catch((erreur) =>
        console.error("[" + merchantKey + "] Echec de la notification marchand (humain) :", erreur)
      );
      let msgChoix = sh.messageChoixContact(session);
      if (reprisePauseHumain) msgChoix = sh.messageReprisePause(session) + "\n\n" + msgChoix;
      journaliser(fromPhone, "bot", msgChoix);
      return msgChoix;
    }

    const intentionRdv = sh.detecterIntentionRdv(text);
    let reponse = intentionRdv ? gererAnnulationOuReport(session, intentionRdv) : processMessage(session, text);

    if (estPremierContact && reponse) {
      humanHintDonne[fromPhone] = true;
      reponse += sh.mentionHumainDisponible(session);
    }
    if (reprisePauseHumain && reponse) {
      reponse = sh.messageReprisePause(session) + "\n\n" + reponse;
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
    // `langue` ("fr"/"en") et `proposedSlotsLabels` (libelles courts, dans la langue de la session et le
    // fuseau du marchand) permettent a server.js de construire les menus WhatsApp cliquables sans rien
    // deviner : boutons de creneaux, titres de listes (voir essayerEnvoyerMenuInteractif).
    return s ? {
      stage: s.stage,
      pretPourChoix: !!s.pretPourChoix,
      proposedSlots: s.proposedSlots || null,
      proposedSlotsLabels: (s.proposedSlots || []).map((d) => libelleCourtCreneau(d, s)),
      langue: sh.langueSession(s)
    } : null;
  }

  // Ne renvoie jamais les rendez-vous crees par le Simulateur (source:"simulateur") — invisibles dans la
  // vraie liste de rendez-vous du marchand et exclus du tableau de bord.
  function getAppointments() {
    if (!state) return [];
    const maintenant = Date.now();
    // Copie avec `rappelStatut` calcule (voir statutRappel) pour que /admin affiche l'etat du rappel.
    return state.appointments.filter((a) => a.source !== "simulateur").map((a) => Object.assign({}, a, { rappelStatut: statutRappel(a, maintenant) }));
  }
  function getServices() { return state ? state.services : []; }
  function getSettings() { return state ? state.settings : {}; }

  // ---------------- Rappel automatique la veille (voir server.js, appele periodiquement) ----------------
  // Etape 44 : un rappel n'est marque "envoye" (rappelEnvoye) qu'une fois REELLEMENT accepte par WhatsApp.
  // Avant, le drapeau etait leve AVANT l'envoi et l'echec (frequent : texte libre refuse hors de la fenetre
  // de 24 h) etait definitif et invisible. Maintenant : texte libre puis repli template (voir
  // options.envoyerRappel), jusqu'a RAPPEL_MAX_TENTATIVES essais espaces (RAPPEL_ATTENTES_MS), et chaque echec
  // reste lisible par le marchand (rappelErreur / rappelStatut dans /admin > Rendez-vous).

  function delaiAvantMs(a, maintenant) { return new Date(a.dateISO).getTime() - maintenant; }

  // "envoye" | "echec" (abandon : essais epuises ou trop tard) | "en_cours" (reessai prevu) | "attendu"
  // (rappel pas encore tente mais prevu) | null (aucun rappel prevu : annule, simulateur, reserve trop tard...).
  function statutRappel(a, maintenant) {
    if (a.source === "simulateur") return null;
    if (a.rappelEnvoye) return "envoye";
    if (a.statut !== "Confirmé") return null;
    const tentatives = a.rappelTentatives || 0;
    const delta = delaiAvantMs(a, maintenant);
    if (delta <= 0) return tentatives > 0 ? "echec" : null;
    if (tentatives > 0) return (tentatives >= RAPPEL_MAX_TENTATIVES || delta < RAPPEL_MARGE_MIN_MS) ? "echec" : "en_cours";
    return null;
  }

  // Un rendez-vous reserve avec MOINS de ~20 h d'avance ne recoit pas de rappel (le client vient de le
  // prendre) ; sans date de creation connue (anciennes donnees), on suppose qu'il est eligible.
  function rappelPrevu(a) {
    if (!a.createdAtISO) return true;
    return new Date(a.dateISO).getTime() - new Date(a.createdAtISO).getTime() >= RAPPEL_DELAI_MIN_MS;
  }

  function texteRappel(a, langue) {
    const session = { langue };
    const quand = formatSlot(new Date(a.dateISO), session);
    return langue === "en"
      ? "Friendly reminder 🙏 You have an appointment " + quand + " for " + a.service + (a.praticienNom ? " with " + a.praticienNom : "") + ". See you soon!\n\n" +
        "(Need to reschedule or cancel? Just write to me here.)"
      : "Petit rappel 🙏 Vous avez rendez-vous " + quand + " pour " + a.service + (a.praticienNom ? " avec " + a.praticienNom : "") + ". À bientôt !\n\n" +
        "(Besoin de reporter ou d'annuler ? Écrivez-le-moi directement ici.)";
  }

  let rappelsEnCours = false; // evite deux passages simultanes (un passage lent + le suivant) = doublons

  async function envoyerRappelsDuJour() {
    if (!state || rappelsEnCours) return;
    rappelsEnCours = true;
    try {
      const maintenant = Date.now();
      const dus = state.appointments.filter((a) => {
        if (a.source === "simulateur") return false;
        if (a.statut !== "Confirmé") return false;
        if (a.rappelEnvoye) return false;
        const tentatives = a.rappelTentatives || 0;
        if (tentatives >= RAPPEL_MAX_TENTATIVES) return false;
        const delta = delaiAvantMs(a, maintenant);
        if (delta < RAPPEL_MARGE_MIN_MS) return false; // trop tard pour que le rappel serve a quelque chose
        if (tentatives > 0) {
          // Reessai : attendre l'heure prevue apres l'echec precedent.
          return !a.rappelProchaineTentativeISO || new Date(a.rappelProchaineTentativeISO).getTime() <= maintenant;
        }
        // Premier essai : des que le rendez-vous passe sous les 24 h (et meme apres un arret du serveur, tant
        // qu'il reste plus de RAPPEL_MARGE_MIN_MS) - sauf rendez-vous pris au dernier moment.
        return delta < RAPPEL_DELAI_MAX_MS && rappelPrevu(a);
      });
      for (const a of dus) {
        const telephone = a.fromWhatsapp || a.telephone;
        const langue = a.langue === "en" ? "en" : "fr";
        const texte = texteRappel(a, langue);
        let resultat;
        try {
          resultat = await envoyerRappelOption(telephone, texte, {
            langue,
            parametres: [a.clientNom || (langue === "en" ? "customer" : "client"), a.service + (a.praticienNom ? (langue === "en" ? " with " : " avec ") + a.praticienNom : ""), formatSlot(new Date(a.dateISO), { langue })]
          });
        } catch (erreur) {
          resultat = { ok: false, erreur: String((erreur && erreur.message) || erreur) };
        }
        a.rappelTentatives = (a.rappelTentatives || 0) + 1;
        a.rappelDerniereTentativeISO = new Date().toISOString();
        if (resultat && resultat.ok !== false) {
          a.rappelEnvoye = true;
          a.rappelCanal = resultat.canal || "texte";
          a.rappelEnvoyeISO = a.rappelDerniereTentativeISO;
          a.rappelErreur = null;
          a.rappelProchaineTentativeISO = null;
          journaliser(telephone, "bot", texte);
        } else {
          a.rappelErreur = ((resultat && resultat.erreur) || "Envoi refusé par WhatsApp").slice(0, 300);
          console.error("[" + merchantKey + "] Echec du rappel pour " + orderRef(a) + " (essai " + a.rappelTentatives + "/" + RAPPEL_MAX_TENTATIVES + ") : " + a.rappelErreur);
          a.rappelProchaineTentativeISO = a.rappelTentatives >= RAPPEL_MAX_TENTATIVES
            ? null
            : new Date(Date.now() + RAPPEL_ATTENTES_MS[Math.min(a.rappelTentatives - 1, RAPPEL_ATTENTES_MS.length - 1)]).toISOString();
        }
        saveState(); // apres CHAQUE rendez-vous : un plantage au milieu du passage ne perd aucune tentative
      }
    } finally {
      rappelsEnCours = false;
    }
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

  // Meme jour calendaire DANS LE FUSEAU DU MARCHAND (Etape 44) - jamais celui du serveur.
  function sameDay(a, b) {
    const pa = sh.partiesFuseau(a, fz());
    const pb = sh.partiesFuseau(b, fz());
    return pa.annee === pb.annee && pa.mois === pb.mois && pa.jour === pb.jour;
  }

  // Memes regles que conversation.js (moteur catalogue) pour le selecteur de periode du Tableau de bord -
  // dupliquees ici car les deux moteurs restent independants (voir commentaire en tete de fichier), mais
  // calculees dans le fuseau du marchand : "aujourd'hui" commence a minuit a Douala, pas a minuit UTC.
  function debutPeriode(periode, dateReference) {
    const p = sh.partiesFuseau(new Date(dateReference), fz());
    let annee = p.annee, mois = p.mois, jour = p.jour;
    if (periode === "semaine") {
      const jourSemaineLundi = (p.jourSemaine + 6) % 7; // 0 = lundi
      const u = new Date(Date.UTC(annee, mois - 1, jour - jourSemaineLundi));
      annee = u.getUTCFullYear(); mois = u.getUTCMonth() + 1; jour = u.getUTCDate();
    } else if (periode === "mois") {
      jour = 1;
    } else if (periode === "trimestre") {
      jour = 1; mois = Math.floor((mois - 1) / 3) * 3 + 1;
    } else if (periode === "annee") {
      jour = 1; mois = 1;
    }
    return sh.dateDepuisPartiesFuseau(annee, mois, jour, 0, 0, fz());
  }

  function finPeriode(periode, debut) {
    const p = sh.partiesFuseau(debut, fz());
    let annee = p.annee, mois = p.mois, jour = p.jour;
    if (periode === "jour") jour += 1;
    else if (periode === "semaine") jour += 7;
    else if (periode === "trimestre") mois += 3;
    else if (periode === "annee") annee += 1;
    else mois += 1; // "mois" (et repli par defaut)
    const u = new Date(Date.UTC(annee, mois - 1, jour));
    return sh.dateDepuisPartiesFuseau(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), 0, 0, fz());
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
      const jour = ajouterJours(new Date(), -d);
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
    const sain = Object.assign({}, patch || {});
    // Le marqueur de migration n'est jamais modifiable de l'exterieur ; un fuseau inconnu est ignore (on
    // garde l'actuel) plutot que de casser tous les calculs de dates.
    delete sain.fuseauMigre;
    if (sain.fuseau !== undefined && !sh.fuseauValide(sain.fuseau)) delete sain.fuseau;
    state.settings = Object.assign({}, state.settings, sain);
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
