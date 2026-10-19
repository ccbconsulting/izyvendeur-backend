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
const sessionsPersistantes = require("./sessionsPersistantes");
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

// Etape 62 : SEUL un rendez-vous "Confirmé" bloque un creneau. Un "Nouvelle" (le client n'a pas dit "oui") ne
// bloque plus rien : il reste visible dans /admin comme un client a relancer. Le risque de course entre deux
// clients sur le meme creneau est couvert par la reverification faite au moment du "oui" (voir
// awaiting_confirmation) et lors du passage manuel a "Confirmé" (updateAppointmentStatus).
const RESERVING_STATUSES_RDV = ["Confirmé"];
// Rendez-vous "vivants" (a venir et pas encore traites) : peuvent etre annules/deplaces par le client ou deplaces
// par la gerante, qu'ils aient ou non confirme.
const ACTIFS_STATUSES_RDV = ["Nouvelle", "Confirmé"];

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

// Etat de depart SANS service de demonstration (second volet d'un marchand hybride, Etape 47).
function seedStateVide() {
  const e = seedState();
  e.services = [];
  return e;
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
      // Etape 68 : listes de jours et d'heures (menus deroulants WhatsApp) proposees a la cliente (case a cocher).
      listesDatesHeures: true,
      // Etape 67 : delai limite d'annulation / report par la cliente (heures avant le rendez-vous ; 0 = aucune
      // limite) et ce qui se passe au-dela : "refuser" (renvoi vers un conseiller) ou "accepter" (le rendez-vous
      // est annule / deplace mais marque « annulation tardive » pour la gerante). Regle par marchand.
      delaiAnnulationHeures: 0,
      modeDelaiDepasse: "refuser",
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
  // Etape 60 : nom commercial du marchand, lu a chaque usage (il peut etre renomme dans /admin) pour
  // personnaliser l'accueil ("Bienvenue chez <nom>"). Sans l'option (tests, ancien appelant) : accueil inchange.
  const nomMarchandOption = (options && options.nomMarchand) || (() => "");
  // Etape 61 : id du rendez-vous qu'un client est en train de DEPLACER. Pendant le traitement de son message,
  // ce rendez-vous ne bloque pas sa propre place (un client qui decale de 10h a 10h30 un soin d'1 h ne doit pas
  // se heurter a lui-meme). Pose juste avant chaque calcul de disponibilite, remis a null en fin de tour.
  let ignorerApptId = null;
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
  // Etape 47 (marchand hybride) : le SECOND moteur d'un marchand hybride partage son identifiant (journal des
  // conversations, alertes) mais range son etat sous une cle distincte (`options.cleEtat`), pour ne jamais
  // melanger catalogue et rendez-vous ; `options.sansDonneesDemo` evite d'y semer les articles/services de
  // demonstration (le marchand n'a encore rien configure dans ce volet). Absents = comportement d'avant.
  const cleEtat = (options && options.cleEtat) || merchantKey;

  // Etape 72 : sauvegarde des sessions de conversation (voir sessionsPersistantes.js). Un rendez-vous « Nouvelle » qui
  // attend le « oui » du client reste en attente jusqu'a l'heure du rendez-vous ; toute autre saisie intermediaire est
  // abandonnee apres 24 h sans message ; la langue choisie est gardee 90 jours.
  const persistance = sessionsPersistantes.creer({
    cle: cleEtat, sessions, conversationsHumain, ignorer: [PHONE_SIMULATEUR],
    regle: (s, age) => {
      const J = sessionsPersistantes.JOUR_MS;
      if (age > sessionsPersistantes.DUREE_MAX_JOURS * J) return null;
      if (age <= J) return s;
      if (s.stage === "awaiting_confirmation" && s.pendingAppointmentId && state) {
        const a = (state.appointments || []).find((x) => x.id === s.pendingAppointmentId);
        if (a && a.statut === "Nouvelle" && new Date(a.dateISO) > new Date()) return s;
      }
      const neuve = freshSession(s); neuve.fromPhone = s.fromPhone;
      return neuve;
    }
  });

  async function init() {
    state = await db.initMerchantState(cleEtat, options && options.sansDonneesDemo ? seedStateVide : seedState);
    if (!state.settings) state.settings = seedState().settings;
    if (!state.settings.horaires) state.settings.horaires = JSON.parse(JSON.stringify(DEFAULT_HORAIRES));
    if (!state.settings.dureeCreneauMinutes) state.settings.dureeCreneauMinutes = DEFAULT_DUREE_CRENEAU_MINUTES;
    if (!state.settings.autoConfirmMessage) state.settings.autoConfirmMessage = DEFAULT_AUTO_CONFIRM_MESSAGE;
    if (typeof state.settings.autoConfirmMessageEn !== "string") state.settings.autoConfirmMessageEn = "";
    if (!Array.isArray(state.settings.praticiens)) state.settings.praticiens = [];
    if (typeof state.settings.listesDatesHeures !== "boolean") state.settings.listesDatesHeures = true; // Etape 68 : listes de jours/heures actives par defaut
    if (!state.appointments) state.appointments = [];
    if (!sh.fuseauValide(state.settings.fuseau)) state.settings.fuseau = sh.FUSEAU_PAR_DEFAUT;
    migrerFuseauRendezvous();
    await persistance.charger();
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
    db.persistMerchantState(cleEtat, state).catch((erreur) => {
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
      // Etape 61 : rendez-vous en cours de deplacement, et choix entre plusieurs rendez-vous.
      reportApptId: null,
      intentionRdv: null,
      choixRdvIds: null,
      // Etape 63 : annulation demandee depuis le menu WhatsApp « Mon rendez-vous » -> confirmation obligatoire.
      confirmerAnnulation: false,
      annulationApptId: null,
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

  // Etape 68 : jeton interne produit par server.js quand le client choisit un jour puis une heure dans les listes
  // WhatsApp (« __creneau:2026-10-21 10:30__ ») - jour et heure exacts, sans aucune heuristique de lecture.
  const RE_JETON_CRENEAU = /^__creneau:(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})__$/;
  function lireJetonCreneau(text) {
    const m = RE_JETON_CRENEAU.exec(String(text == null ? "" : text).trim());
    return m ? { annee: +m[1], mois: +m[2], jour: +m[3], h: +m[4], m: +m[5] } : null;
  }
  const MOIS_NUMERO = {
    janvier: 1, janv: 1, fevrier: 2, fevr: 2, mars: 3, avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
    aout: 8, septembre: 9, sept: 9, octobre: 10, oct: 10, novembre: 11, nov: 11, decembre: 12, dec: 12,
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  const RE_MOIS = "janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec|january|february|march|april|may|june|july|august|september|october|november|december";
  // Date ecrite en chiffres (« 21/10 », « 21-10-2026 ») ou avec le nom du mois (« 21 octobre », « Oct 21 ») -> instant
  // de minuit du jour dans le fuseau du marchand, ou null. Sans annee : l'annee en cours, ou la suivante si la date
  // est passee depuis plus de 30 jours (« 5/1 » ecrit en octobre = janvier prochain).
  function lireDateEcrite(text, now) {
    const t = sansAccents(String(text)).toLowerCase();
    let jour = null, mois = null, annee = null;
    let m = t.match(/\b(\d{1,2})\s*[\/\-]\s*(\d{1,2})(?:\s*[\/\-]\s*(\d{4}|\d{2}))?\b/);
    if (m) { jour = +m[1]; mois = +m[2]; if (m[3]) annee = m[3].length === 2 ? 2000 + +m[3] : +m[3]; }
    if (jour === null) {
      m = t.match(new RegExp("\\b(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(?:de\\s+|of\\s+)?(" + RE_MOIS + ")\\b(?:\\s+(\\d{4}))?"));
      if (m) { jour = +m[1]; mois = MOIS_NUMERO[m[2]]; if (m[3]) annee = +m[3]; }
    }
    if (jour === null) {
      m = t.match(new RegExp("\\b(" + RE_MOIS + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s+(\\d{4}))?"));
      if (m) { mois = MOIS_NUMERO[m[1]]; jour = +m[2]; if (m[3]) annee = +m[3]; }
    }
    if (jour === null || !mois || mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;
    const auj = sh.partiesFuseau(now, fz());
    const construire = (a) => {
      const d = sh.dateDepuisPartiesFuseau(a, mois, jour, 0, 0, fz());
      const p = sh.partiesFuseau(d, fz());
      return p.annee === a && p.mois === mois && p.jour === jour ? d : null;
    };
    let d = construire(annee || auj.annee);
    if (!d) return null;
    if (!annee && d.getTime() < startOfDay(now).getTime() - 30 * 86400000) d = construire(auj.annee + 1) || d;
    return d;
  }

  function parseRequestedDate(text, now) {
    const jeton = lireJetonCreneau(text);
    if (jeton) return sh.dateDepuisPartiesFuseau(jeton.annee, jeton.mois, jeton.jour, 0, 0, fz());
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
    return lireDateEcrite(text, now);
  }

  // Renvoie { h, m } (heure murale, sans date) - a recombiner avec un jour par l'appelant (composer()).
  // Francais : "10h", "10h30", "10:30" ; anglais : "10am", "2:30 pm", "noon" ; "midi" dans les deux langues.
  function parseRequestedTime(text) {
    const jeton = lireJetonCreneau(text);
    if (jeton) return { h: jeton.h, m: jeton.m };
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
      if (ignorerApptId !== null && a.id === ignorerApptId) return false;
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

  // ---------------- Etape 68 : listes de jours puis d'heures (menus deroulants WhatsApp) ----------------
  // Le moteur ne fait que CALCULER ce qui est libre ; server.js construit les listes cliquables et renvoie le choix du
  // client sous forme du jeton « __creneau:AAAA-MM-JJ HH:MM__ » (voir lireJetonCreneau). La saisie libre reste
  // possible a tout moment. Reglage du marchand : settings.listesDatesHeures (vrai par defaut).
  const pad2 = (n) => String(n).padStart(2, "0");
  function listesActives() { return !state || !state.settings || state.settings.listesDatesHeures !== false; }
  function isoJour(d) { const p = sh.partiesFuseau(d, fz()); return p.annee + "-" + pad2(p.mois) + "-" + pad2(p.jour); }
  function jourDepuisISO(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return null;
    const d = sh.dateDepuisPartiesFuseau(+m[1], +m[2], +m[3], 0, 0, fz());
    const p = sh.partiesFuseau(d, fz());
    return p.annee === +m[1] && p.mois === +m[2] && p.jour === +m[3] ? d : null;
  }
  function libelleJourCourt(d, session) {
    const p = sh.partiesFuseau(d, fz());
    if (sh.langueSession(session) === "en") return capitalize(DAY_KEYS_EN[p.jourSemaine]).slice(0, 3) + " " + p.jour + " " + MOIS_COURTS_EN[p.mois - 1];
    return capitalize(DAY_KEYS[p.jourSemaine]).slice(0, 3) + " " + pad2(p.jour) + "/" + pad2(p.mois);
  }
  function libelleHeure(d, session) {
    const p = sh.partiesFuseau(d, fz());
    if (sh.langueSession(session) === "en") return (p.heure % 12 === 0 ? 12 : p.heure % 12) + ":" + pad2(p.minute) + (p.heure < 12 ? " AM" : " PM");
    return p.heure + "h" + (p.minute === 0 ? "" : pad2(p.minute));
  }
  // Session eligible aux listes : etape « jour et heure » (ou choix parmi des propositions) d'un service connu.
  function contexteListes(fromPhone) {
    if (!state || !listesActives()) return null;
    const s = sessions[fromPhone];
    if (!s || (s.stage !== "awaiting_datetime" && s.stage !== "awaiting_slot_choice")) return null;
    const service = serviceActuel(s);
    return service ? { s, service } : null;
  }
  function avecReport(session, fn) {
    const avant = ignorerApptId;
    ignorerApptId = session.reportApptId || null; // un rendez-vous en cours de report ne bloque pas son propre creneau
    try { return fn(); } finally { ignorerApptId = avant; }
  }
  // Jours ayant au moins un creneau libre (60 jours max), par pages de 7 : { jours:[{id,label,description}], suite, page } ou null.
  function getChoixJours(fromPhone, page) {
    const ctx = contexteListes(fromPhone);
    if (!ctx) return null;
    return avecReport(ctx.s, () => {
      const now = new Date();
      const trouves = [];
      let cur = startOfDay(now);
      for (let i = 0; i < 60; i++) {
        const libres = freeSlotsForDay(cur, ctx.service.dureeMinutes, now, ctx.s.praticienId || null);
        if (libres.length) trouves.push({ date: cur, nb: libres.length, i });
        cur = ajouterJours(cur, 1);
      }
      const pg = Math.max(0, parseInt(page, 10) || 0);
      const part = trouves.slice(pg * 7, pg * 7 + 7);
      return {
        page: pg,
        suite: trouves.length > pg * 7 + 7,
        jours: part.map((j) => ({
          id: isoJour(j.date),
          label: libelleJourCourt(j.date, ctx.s),
          description: (j.i === 0 ? sh.t(ctx.s, "Aujourd'hui — ", "Today — ") : j.i === 1 ? sh.t(ctx.s, "Demain — ", "Tomorrow — ") : "") +
            sh.t(ctx.s, j.nb + (j.nb > 1 ? " créneaux libres" : " créneau libre"), j.nb + (j.nb > 1 ? " free slots" : " free slot"))
        }))
      };
    });
  }
  // Creneaux libres d'un jour : { jourId, jourLabel, creneaux:[{id:"HH:MM", label, heure}] } ou null.
  function getChoixHeures(fromPhone, jourIso) {
    const ctx = contexteListes(fromPhone);
    const jour = jourDepuisISO(jourIso);
    if (!ctx || !jour) return null;
    return avecReport(ctx.s, () => {
      const libres = freeSlotsForDay(jour, ctx.service.dureeMinutes, new Date(), ctx.s.praticienId || null);
      return {
        jourId: jourIso,
        jourLabel: libelleJourCourt(jour, ctx.s),
        creneaux: libres.map((d) => { const p = sh.partiesFuseau(d, fz()); return { id: pad2(p.heure) + ":" + pad2(p.minute), label: libelleHeure(d, ctx.s), heure: p.heure }; })
      };
    });
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
      // Etape 61 : id du rendez-vous que celui-ci REMPLACE (report par le client) ; l'ancien n'est annule qu'a la
      // confirmation du nouveau (voir awaiting_confirmation).
      remplaceId: session.reportApptId || null,
      // Langue de la conversation (Etape 45) : le rappel automatique est envoye dans cette langue.
      langue: sh.langueSession(session),
      // Rappel automatique la veille (voir envoyerRappelsDuJour) - `rappelEnvoye` ne passe a true qu'une
      // fois le message REELLEMENT livre a WhatsApp (Etape 44) ; rappelTentatives/rappelErreur/
      // rappelProchaineTentativeISO/rappelCanal documentent les essais.
      rappelEnvoye: false,
      rappelTentatives: 0,
      // Facturation IzyFacture (Etape 46) : meme schema que les commandes du catalogue (voir
      // conversation.js), rempli par server.js quand le rendez-vous passe a "Honoré".
      izyfacturePaiements: [],
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
    const ancienRdv = session.reportApptId ? rdvParId(session.reportApptId) : null;
    if (ancienRdv && ancienRdv.clientNom) {
      // Report (Etape 61) : le nom est celui du rendez-vous d'origine, inutile de le redemander.
      session.clientNom = ancienRdv.clientNom;
      return finaliserReservation(session, true);
    }
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

  // Etape 70 : message d'accueil PERSONNALISE du marchand (Parametres > rendez-vous), dans la langue du client (le champ de
  // l'autre langue sert de repli). Vide par defaut : l'accueil standard « Bienvenue chez <nom> » est alors inchange.
  function accueilPerso(session) {
    const r = (state && state.settings) || {};
    const fr = String(r.messageAccueilSupplementaire || "").trim(), en = String(r.messageAccueilSupplementaireEn || "").trim();
    return sh.langueSession(session) === "en" ? (en || fr) : (fr || en);
  }
  function messageChoixService(session, introFr, introEn) {
    session.accueilPersoAffiche = false;
    return sh.t(session,
      introFr + " Nous proposons : " + listeServicesTexte() + ".",
      introEn + " We offer: " + listeServicesTexte() + "."
    );
  }

  // Cree le rendez-vous "Nouvelle" a partir d'un creneau choisi et d'un nom connu, et renvoie le recapitulatif a
  // confirmer. `report` (Etape 61) = le client DEPLACE un rendez-vous existant : pas d'anti-inondation (le
  // nombre de rendez-vous ne change pas) et le recapitulatif precise que l'ancien sera annule a la confirmation.
  function finaliserReservation(session, report) {
    if (!report) {
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
    const ancien = appt.remplaceId ? rdvParId(appt.remplaceId) : null;
    const noteRemplace = ancien
      ? sh.t(session,
          "\nIl remplace votre rendez-vous " + orderRef(ancien) + " (" + formatSlot(new Date(ancien.dateISO), session) + "), qui ne sera annulé qu'une fois ce nouveau rendez-vous confirmé.",
          "\nIt replaces your appointment " + orderRef(ancien) + " (" + formatSlot(new Date(ancien.dateISO), session) + "), which will only be cancelled once this new appointment is confirmed.")
      : "";
    return ouverture(session, OUVERTURES_RECAP, OUVERTURES_RECAP_EN) + sh.t(session,
      " Voici le récapitulatif de votre " + (ancien ? "nouveau " : "") + "rendez-vous (" + orderRef(appt) + ") :\n" +
        "• " + service.nom + " — " + formatSlot(slotStart, session) + " — " + formatFcfa(service.prix) + (appt.praticienNom ? " — avec " + appt.praticienNom : "") + "\n" +
        "Au nom de : " + session.clientNom + noteRemplace + "\n\nConfirmez-vous ce rendez-vous ? (oui / non)",
      " Here is the summary of your " + (ancien ? "new " : "") + "appointment (" + orderRef(appt) + "):\n" +
        "• " + service.nom + " — " + formatSlot(slotStart, session) + " — " + formatFcfa(service.prix) + (appt.praticienNom ? " — with " + appt.praticienNom : "") + "\n" +
        "Under the name: " + session.clientNom + noteRemplace + "\n\nDo you confirm this appointment? (yes / no)"
    );
  }

  // Etape 62 : au "oui" du client, le creneau doit etre toujours libre (aucun AUTRE rendez-vous confirme dessus,
  // l'ancien rendez-vous d'un report etant ignore par ignorerApptId). Si un autre praticien est libre, on lui
  // reassigne le rendez-vous. Sinon : le rendez-vous provisoire est annule (motif lisible), et on repropose les
  // creneaux les plus proches. Renvoie null si tout va bien, sinon le message a envoyer au client.
  function verifierCreneauAvantConfirmation(session, appt) {
    const debut = new Date(appt.dateISO);
    const duree = appt.dureeMinutes || 30;
    const now = new Date();
    const dejaPasse = debut.getTime() <= now.getTime();
    let libre = !dejaPasse && isSlotFreePour(debut, duree, appt.praticienId || null);
    if (!dejaPasse && !libre && getPraticiens().length > 1) {
      const autre = choisirPraticienLibre(debut, duree);
      if (autre) {
        appt.praticienId = autre;
        appt.praticienNom = praticienNomParId(autre);
        libre = true;
      }
    }
    if (libre) return null;
    applyStatusChange(appt, "Annulé", dejaPasse ? "Créneau dépassé avant la confirmation du client" : "Créneau pris par un autre client avant la confirmation");
    session.pendingAppointmentId = null;
    session.pendingSlotISO = null;
    const service = serviceActuel(session) || { nom: appt.service, dureeMinutes: duree };
    const praticienId = session.praticienId || null;
    const dateOnly = startOfDay(debut.getTime() > now.getTime() ? debut : now);
    let alternatives = freeSlotsForDay(dateOnly, duree, now, praticienId);
    const cible = debut.getTime();
    alternatives = alternatives.slice().sort((a, b) => Math.abs(a.getTime() - cible) - Math.abs(b.getTime() - cible)).slice(0, 3);
    if (!alternatives.length) alternatives = nextAvailableFrom(ajouterJours(dateOnly, 1), duree, now, 3, praticienId);
    const excuse = dejaPasse
      ? sh.t(session, "Désolée, ce créneau est déjà passé. ", "Sorry, that time has already passed. ")
      : sh.t(session, "Désolée, ce créneau vient d'être pris par quelqu'un d'autre avant votre confirmation. ", "Sorry, that slot has just been taken by someone else before you confirmed. ");
    if (!alternatives.length) {
      session.stage = "awaiting_datetime";
      return excuse + sh.t(session,
        "Quel autre jour et quelle heure vous conviendraient pour votre " + service.nom + " ?",
        "Which other day and time would suit you for your " + service.nom + "?"
      );
    }
    session.proposedSlots = alternatives;
    session.stage = "awaiting_slot_choice";
    const liste = alternatives.map((x, i) => (i + 1) + ". " + formatSlot(x, session)).join("\n");
    return excuse + sh.t(session,
      "Voici les créneaux les plus proches pour " + service.nom + " :\n" + liste + "\n\nLequel vous convient ? (répondez par l'heure ou le numéro)",
      "Here are the closest available times for " + service.nom + ":\n" + liste + "\n\nWhich one suits you? (reply with the time or the number)"
    );
  }

  function rdvParId(id) {
    return state.appointments.filter((a) => a.id === Number(id))[0] || null;
  }

  // Le client renonce a deplacer son rendez-vous (« non », « autre chose ») : l'ancien reste TEL QUEL.
  function messageReportAbandonne(session) {
    const ancien = session.reportApptId ? rdvParId(session.reportApptId) : null;
    abandonnerReportEnCours(session);
    resetSession(session);
    if (!ancien) return null;
    return sh.t(session,
      "Très bien, votre rendez-vous " + orderRef(ancien) + " (" + ancien.service + ", " + formatSlot(new Date(ancien.dateISO), session) + ") est conservé.",
      "Alright, your appointment " + orderRef(ancien) + " (" + ancien.service + ", " + formatSlot(new Date(ancien.dateISO), session) + ") is kept as it is."
    );
  }

  // Si un nouveau rendez-vous provisoire ("Nouvelle", lie a un report) existe deja, il est annule : l'ancien reste.
  function abandonnerReportEnCours(session) {
    if (!session.reportApptId || !session.pendingAppointmentId) return;
    const nouveau = rdvParId(session.pendingAppointmentId);
    if (nouveau && nouveau.statut === "Nouvelle" && nouveau.remplaceId === session.reportApptId) {
      applyStatusChange(nouveau, "Annulé", "Report abandonné par le client");
    }
  }

  // Alerte la gerante (en francais, quelle que soit la langue du client) quand une CLIENTE annule ou deplace un
  // rendez-vous. Jamais pour un rendez-vous du Simulateur.
  function alerterRdvModifie(action, ancien, nouveau) {
    if (!ancien || ancien.source === "simulateur") return;
    notifierMarchand("rdv_modifie", [
      orderRef(ancien),
      ancien.service + (ancien.praticienNom ? " (avec " + ancien.praticienNom + ")" : ""),
      (action === "annule" ? "annulé" : "déplacé") + (ancien.annulationTardive ? " TARDIVEMENT" : "") + " par la cliente",
      formatSlot(new Date(ancien.dateISO), null),
      nouveau ? formatSlot(new Date(nouveau.dateISO), null) : "aucun (annulation)",
      ancien.clientNom || "—",
      ancien.telephone || "—"
    ]).catch((erreur) =>
      console.error("[" + merchantKey + "] Echec de la notification marchand (rendez-vous " + action + ") :", erreur)
    );
  }

  function processMessage(session, text) {
    // Reinitialise a chaque tour - seuls les 3 points de retour "quel service vous interesse ?" plus bas
    // le repassent a true juste avant de renvoyer leur texte (voir freshSession() ci-dessus).
    session.pretPourChoix = false;

    if (session.stage === "awaiting_rdv_choice") {
      // Plusieurs rendez-vous a venir (Etape 61) : le client designe celui qu'il veut annuler/deplacer.
      const ids = session.choixRdvIds || [];
      let choisi = null;
      const brut = String(text || "").trim();
      const ref = brut.match(/rdv[\s-]*0*(\d+)/i);
      if (ref && ids.indexOf(Number(ref[1])) !== -1) choisi = Number(ref[1]);
      if (choisi === null) {
        const num = brut.match(/^\D{0,12}(\d{1,2})\D{0,3}$/);
        if (num && Number(num[1]) >= 1 && Number(num[1]) <= ids.length) choisi = ids[Number(num[1]) - 1];
      }
      const appt = choisi !== null ? rdvParId(choisi) : null;
      if (appt) {
        const intention = session.intentionRdv;
        const avecConfirmation = session.confirmerAnnulation;
        session.choixRdvIds = null; session.intentionRdv = null; session.confirmerAnnulation = false;
        if (intention === "annuler" && avecConfirmation) return demanderConfirmationAnnulation(session, appt);
        return appliquerIntentionRdv(session, intention, appt);
      }
      if (parseNegative(text) || parseWantsSomethingElse(text)) {
        resetSession(session);
        return sh.t(session, "Très bien, vos rendez-vous restent inchangés.", "Alright, your appointments stay as they are.");
      }
      return sh.t(session,
        "Je n'ai pas compris. Répondez par le numéro du rendez-vous concerné (1 à " + ids.length + "), ou « non » pour ne rien changer.",
        "I didn't understand. Reply with the number of the appointment (1 to " + ids.length + "), or \"no\" to change nothing."
      );
    }

    if (session.stage === "awaiting_annulation_confirm") {
      const appt = session.annulationApptId ? rdvParId(session.annulationApptId) : null;
      if (!appt || ACTIFS_STATUSES_RDV.indexOf(appt.statut) === -1) {
        resetSession(session);
        return sh.t(session, "Ce rendez-vous n'est plus à venir : rien à annuler.", "That appointment is no longer upcoming: nothing to cancel.");
      }
      if (parseAffirmative(text)) return appliquerIntentionRdv(session, "annuler", appt);
      if (parseNegative(text) || parseWantsSomethingElse(text)) {
        resetSession(session);
        return sh.t(session,
          "Très bien, votre rendez-vous " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + ") est conservé.",
          "Alright, your appointment " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + ") is kept."
        );
      }
      return sh.t(session,
        "Je n'ai pas compris. Souhaitez-vous annuler votre rendez-vous " + orderRef(appt) + " ? Répondez par oui ou non.",
        "I didn't understand. Do you want to cancel your appointment " + orderRef(appt) + "? Please reply yes or no."
      );
    }

    if (session.stage === "awaiting_datetime") {
      const autresServices = matchServicesMultiple(text);
      const memeService = autresServices.length && autresServices.slice().sort().join("+") === (session.serviceIds || []).slice().sort().join("+");
      if (autresServices.length && !memeService && !session.reportApptId) {
        resetSession(session);
        return processMessage(session, text);
      }
      const praticienDemande = matchPraticien(text);
      if (praticienDemande) session.praticienId = praticienDemande;
      if (parseNegative(text) || parseWantsSomethingElse(text)) {
        if (session.reportApptId) return messageReportAbandonne(session);
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
        if (session.reportApptId) return messageReportAbandonne(session);
        resetSession(session);
        session.pretPourChoix = true;
        return messageChoixService(session, "Pas de souci ! Quel service vous intéresse ?", "No problem! Which service are you interested in?");
      }
      const autresServices = matchServicesMultiple(text);
      const memeService = autresServices.length && autresServices.slice().sort().join("+") === (session.serviceIds || []).slice().sort().join("+");
      if (autresServices.length && !memeService && !session.reportApptId) {
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
      return finaliserReservation(session, false);
    }

    if (session.stage === "awaiting_confirmation") {
      const appt = state.appointments.filter((a) => a.id === session.pendingAppointmentId)[0];
      if (appt && parseAffirmative(text)) {
        // Etape 62 : le creneau n'est reserve qu'au "oui". On reverifie qu'il est toujours libre (un autre client a
        // pu le confirmer entre-temps) ; sinon on s'excuse et on propose d'autres creneaux.
        const conflit = verifierCreneauAvantConfirmation(session, appt);
        if (conflit) return conflit;
        applyStatusChange(appt, "Confirmé");
        // Etape 61 : report -> l'ancien rendez-vous n'est annule QU'ICI, une fois le nouveau confirme ; une seule
        // alerte « déplacé » part vers la gerante (au lieu de « confirmé » + « annulé »).
        const ancienRemplace = appt.remplaceId ? rdvParId(appt.remplaceId) : null;
        if (ancienRemplace && ACTIFS_STATUSES_RDV.indexOf(ancienRemplace.statut) !== -1) {
          const reportTardif = rdvHorsDelai(ancienRemplace); // avant le changement de statut
          applyStatusChange(ancienRemplace, "Annulé", (reportTardif ? "Reporté tardivement par le client via WhatsApp (moins de " + delaiHeures() + " h avant le rendez-vous, remplacé par " : "Reporté par le client via WhatsApp (remplacé par ") + orderRef(appt) + ")");
          if (reportTardif) ancienRemplace.annulationTardive = true;
          ancienRemplace.remplaceParId = appt.id;
          saveState();
          alerterRdvModifie("reporte", ancienRemplace, appt);
        }
        // Cote marchand : toujours en francais (comme les autres alertes), quelle que soit la langue du client.
        if (!ancienRemplace) notifierMarchand("rdv_confirme", [
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
      if (appt && appt.remplaceId && parseNegative(text)) {
        // Report refuse au dernier moment : le nouveau creneau provisoire est annule, l'ancien rendez-vous reste.
        return messageReportAbandonne(session);
      }
      if (appt && parseNegative(text)) {
        const reply = sh.t(session,
          "Très bien, ce créneau n'est pas réservé. Vous pouvez reprendre rendez-vous quand vous voulez ; notre équipe pourra aussi vous recontacter.",
          "Alright, that slot is not booked. You can book again whenever you like; our team may also get back to you."
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
      const nomAccueil = String(nomMarchandOption() || "").trim();
      const perso = accueilPerso(session);
      if (perso) {
        const rep = messageChoixService(session, perso + "\n\nQuel service vous intéresse ?", perso + "\n\nWhich service are you interested in?");
        session.accueilPersoAffiche = true;
        return rep;
      }
      return nomAccueil
        ? messageChoixService(session,
            "Bonjour ! Bienvenue chez " + nomAccueil + ". Quel service vous intéresse ?",
            "Hello! Welcome to " + nomAccueil + ". Which service are you interested in?")
        : messageChoixService(session, "Bonjour ! Quel service vous intéresse ?", "Hello! Which service are you interested in?");
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

  function rdvsAVenirDuClient(telephone) {
    const maintenant = new Date();
    return state.appointments
      .filter((a) => a.fromWhatsapp === telephone && ACTIFS_STATUSES_RDV.indexOf(a.statut) !== -1 && new Date(a.dateISO) > maintenant)
      .sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
  }

  // Etape 67 : delai limite d'annulation / report. Seul un rendez-vous « Confirmé » est concerne (un « Nouvelle »
  // n'a pas encore ete confirme par la cliente : elle peut toujours l'abandonner).
  function modeDelai() { return state && state.settings && state.settings.modeDelaiDepasse === "accepter" ? "accepter" : "refuser"; }
  function delaiHeures() { const h = parseFloat(state && state.settings && state.settings.delaiAnnulationHeures); return h > 0 ? h : 0; }
  function rdvHorsDelai(appt) {
    const h = delaiHeures();
    if (!h || !appt || appt.statut !== "Confirmé") return false;
    return new Date(appt.dateISO).getTime() - Date.now() < h * 3600000;
  }
  function messageDelaiDepasse(session, appt) {
    const h = delaiHeures();
    return sh.t(session,
      "Votre rendez-vous " + orderRef(appt) + " a lieu dans moins de " + h + " h : au-delà de ce délai, l'annulation ou le report ne se fait plus ici. Écrivez « conseiller » et notre équipe s'en occupe.",
      "Your appointment " + orderRef(appt) + " is in less than " + h + " h: past that deadline, cancelling or rescheduling can no longer be done here. Type \"advisor\" and our team will take care of it.");
  }

  // Etape 63 : un bouton « Annuler » du menu est plus facile a toucher par erreur qu'un message ecrit : on demande
  // donc une confirmation (Oui/Non) avant d'annuler. Un message ecrit (« annuler mon rendez-vous ») reste direct.
  function demanderConfirmationAnnulation(session, appt) {
    if (rdvHorsDelai(appt) && modeDelai() === "refuser") { resetSession(session); return messageDelaiDepasse(session, appt); }
    session.stage = "awaiting_annulation_confirm";
    session.annulationApptId = appt.id;
    return sh.t(session,
      "Confirmez-vous l'annulation de votre rendez-vous " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + ") ? (oui / non)",
      "Do you confirm the cancellation of your appointment " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + ")? (yes / no)"
    );
  }

  // Nombre de rendez-vous a venir (non traites) d'un client : sert a server.js pour n'afficher la ligne
  // « Mon rendez-vous » du menu que si elle a un sens.
  function nbRdvsAVenir(telephone) {
    if (!state || !telephone) return 0;
    return rdvsAVenirDuClient(telephone).length;
  }

  // Etape 72 : detail des rendez-vous a venir d'un client (cinq au plus), affiche au-dessus des choix de l'ecran
  // « Mon rendez-vous » pour que la cliente voie ce qu'elle va annuler ou reporter. Chaine vide s'il n'y en a aucun.
  function detailRdvsAVenir(telephone) {
    if (!state || !telephone) return "";
    const s = sessions[telephone] || {};
    const liste = rdvsAVenirDuClient(telephone);
    if (!liste.length) return "";
    const lignes = liste.slice(0, 5).map((a) => {
      const details = [formatSlot(new Date(a.dateISO), s)];
      if (a.praticienNom) details.push(a.praticienNom);
      if (a.prix) details.push(formatFcfa(a.prix));
      details.push(a.statut === "Confirmé" ? sh.t(s, "confirmé", "confirmed") : sh.t(s, "à confirmer", "to be confirmed"));
      return "• " + orderRef(a) + " — " + a.service + "\n   " + details.join(" · ");
    });
    const plusieurs = liste.length > 1;
    return sh.t(s, plusieurs ? "Vos rendez-vous :" : "Votre rendez-vous :", plusieurs ? "Your appointments:" : "Your appointment:") + "\n" + lignes.join("\n") + (liste.length > 5 ? "\n…" : "");
  }

  function gererAnnulationOuReport(session, intention, confirmer) {
    // Un report deja en cours (nouveau creneau provisoire) est abandonne : on repart de l'etat reel des rendez-vous.
    abandonnerReportEnCours(session);
    resetSession(session);
    const prochains = rdvsAVenirDuClient(session.fromPhone);
    if (!prochains.length) {
      return sh.t(session,
        "Je ne trouve pas de rendez-vous à venir associé à ce numéro. Souhaitez-vous en prendre un nouveau ? Quel service vous intéresse ?",
        "I can't find any upcoming appointment linked to this number. Would you like to book a new one? Which service are you interested in?"
      );
    }
    if (prochains.length === 1) {
      if (intention === "annuler" && confirmer) return demanderConfirmationAnnulation(session, prochains[0]);
      return appliquerIntentionRdv(session, intention, prochains[0]);
    }

    // Plusieurs rendez-vous a venir (Etape 61) : on demande lequel, au lieu de decider a la place du client.
    session.stage = "awaiting_rdv_choice";
    session.intentionRdv = intention;
    session.choixRdvIds = prochains.slice(0, 5).map((a) => a.id);
    session.confirmerAnnulation = intention === "annuler" && !!confirmer;
    const liste = prochains.slice(0, 5).map((a, i) => (i + 1) + ". " + orderRef(a) + " — " + a.service + " — " + formatSlot(new Date(a.dateISO), session)).join("\n");
    return sh.t(session,
      "Vous avez plusieurs rendez-vous à venir :\n" + liste + "\n\nLequel souhaitez-vous " + (intention === "annuler" ? "annuler" : "déplacer") + " ? (répondez par le numéro)",
      "You have several upcoming appointments:\n" + liste + "\n\nWhich one would you like to " + (intention === "annuler" ? "cancel" : "move") + "? (reply with the number)"
    );
  }

  function appliquerIntentionRdv(session, intention, appt) {
    const horsDelai = rdvHorsDelai(appt);
    if (horsDelai && modeDelai() === "refuser") { resetSession(session); return messageDelaiDepasse(session, appt); }
    if (intention === "annuler") {
      applyStatusChange(appt, "Annulé", horsDelai
        ? "Annulé tardivement par le client via WhatsApp (moins de " + delaiHeures() + " h avant le rendez-vous)"
        : "Annulé par le client via WhatsApp");
      if (horsDelai) { appt.annulationTardive = true; saveState(); }
      resetSession(session);
      alerterRdvModifie("annule", appt, null);
      return sh.t(session,
        "Votre rendez-vous " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + ") est annulé. N'hésitez pas à revenir si vous souhaitez reprendre un rendez-vous.",
        "Your appointment " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + ") has been cancelled. Feel free to come back if you'd like to book another one."
      );
    }

    // "reporter" (Etape 61, sans risque) : l'ancien rendez-vous N'EST PAS annule ici. Il reste valable tant que le
    // nouveau n'est pas confirme (voir awaiting_confirmation) ; si le client abandonne, rien n'est perdu.
    resetSession(session);
    session.reportApptId = appt.id;
    ignorerApptId = appt.id;
    const service = combinerServices(String(appt.serviceId || "").split("+")) || state.services.filter((s) => s.id === appt.serviceId)[0];
    const rappel = sh.t(session,
      "Votre rendez-vous actuel : " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + "). Il reste valable tant que le nouveau n'est pas confirmé. ",
      "Your current appointment: " + orderRef(appt) + " (" + appt.service + ", " + formatSlot(new Date(appt.dateISO), session) + "). It stays valid until the new one is confirmed. "
    );
    if (!service) {
      session.pretPourChoix = true;
      return rappel + messageChoixService(session,
        "Quel service souhaitez-vous pour le nouveau rendez-vous ?",
        "Which service would you like for the new appointment?"
      );
    }
    session.serviceIds = service.combo || [service.id];
    session.serviceId = session.serviceIds.join("+");
    if (appt.praticienId) session.praticienId = appt.praticienId;
    return rappel + handleDateTimeAttempt(session, "", service);
  }

  // `opts.sansJournalClient` (Etape 47, routeur hybride) : le texte ne vient pas tel quel du client (salutation
  // synthetique apres le menu, message d'origine rejoue apres la porte de langue) ou a deja ete journalise
  // par le routeur : on ne l'ecrit pas une seconde fois dans l'historique.
  // On retient la derniere reponse de CHAQUE client (voir reponseDeReprise) : un client d'un marchand hybride qui
  // quitte ce volet en plein parcours (panier, saisie du nom...) retrouve exactement sa derniere question en y
  // revenant, au lieu qu'une phrase synthetique soit prise pour sa reponse (ex: « Bonjour » comme nom).
  function handleMessage(fromPhone, text, opts) {
    const reponse = traiterMessage(fromPhone, text, opts);
    if (reponse && sessions[fromPhone]) sessions[fromPhone].derniereReponse = reponse;
    persistance.enregistrer(fromPhone);
    return reponse;
  }

  // Derniere question posee a ce client SI son parcours est en cours dans ce moteur (pas au repos), sinon null.
  // Ne modifie rien. Utilisee par le routeur hybride pour reprendre un volet la ou le client l'avait laisse.
  function reponseDeReprise(fromPhone) {
    const s = sessions[fromPhone];
    if (!s || !s.derniereReponse) return null;
    const enCours = s.stage !== "idle" || !!s.pendingChoice || !!s.attenteChoixContactHumain;
    return enCours ? s.derniereReponse : null;
  }

  function traiterMessage(fromPhone, text, opts) {
    if (!state) return sh.t(sessions[fromPhone], "Le service redémarre, un instant s'il vous plaît...", "The service is restarting, one moment please...");

    if (!(opts && opts.sansJournalClient)) {
      const jeton = lireJetonCreneau(text);
      const jourJeton = jeton ? sh.dateDepuisPartiesFuseau(jeton.annee, jeton.mois, jeton.jour, jeton.h, jeton.m, fz()) : null;
      journaliser(fromPhone, "client", jourJeton ? formatSlot(jourJeton, sessions[fromPhone]) : text);
    }

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
    let reponse;
    ignorerApptId = session.reportApptId || null;
    try {
      reponse = intentionRdv ? gererAnnulationOuReport(session, intentionRdv, !!(opts && opts.confirmerAnnulation)) : processMessage(session, text);
    } finally {
      ignorerApptId = null;
    }

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


  // ---------------- Routage hybride (Etape 47, voir server.js : routeur du webhook) ----------------
  // Impose la langue deja choisie par le client aupres du routeur (porte de langue unique pour tout le marchand
  // hybride) : cree la session si besoin et marque la porte de langue comme franchie, sans rien repondre.
  function definirLangueSession(fromPhone, langue) {
    const s = getSession(fromPhone);
    s.langue = langue === "en" ? "en" : "fr";
    s.gateLangueEnvoyee = true;
    delete s.texteAvantLangue;
    persistance.enregistrer(fromPhone);
    return s.langue;
  }

  // true tant qu'une pause "conversation avec un humain" est EN COURS pour ce client (sans jamais la lever
  // elle-meme, contrairement a sh.pauseHumainActive) : le routeur laisse alors le client sur ce volet, ou
  // le message reste sans reponse automatique jusqu'a la fin de la pause.
  function estEnPauseHumain(fromPhone) {
    const c = conversationsHumain[fromPhone];
    if (!c || !c.enAttente) return false;
    return (Date.now() - new Date(c.depuisISO).getTime()) < sh.DUREE_PAUSE_HUMAIN_MS;
  }
  // Langue de la session de ce client ("fr"/"en"), ou null s'il n'a pas encore de session dans ce moteur.
  function langueDeSession(fromPhone) {
    const s = sessions[fromPhone];
    return s ? sh.langueSession(s) : null;
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
      // Etape 63 : choix entre plusieurs rendez-vous (liste cliquable) - [{ ref, detail }] dans l'ordre des numeros.
      rdvChoix: s.stage === "awaiting_rdv_choice" && s.choixRdvIds
        ? s.choixRdvIds.map((id) => rdvParId(id)).filter(Boolean).map((a) => ({ ref: orderRef(a), detail: a.service + " — " + formatSlot(new Date(a.dateISO), s) }))
        : null,
      // Etape 68 : le client doit donner un jour et une heure -> server.js peut proposer la liste des jours.
      choixDate: s.stage === "awaiting_datetime" && !!contexteListes(fromPhone),
      accueilPerso: !!s.pretPourChoix && !!s.accueilPersoAffiche, // Etape 70 : le texte contient l'accueil personnalise du marchand
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
  function handleMessageSimulateur(text, opts) {
    const reponse = handleMessage(PHONE_SIMULATEUR, text, opts);
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
    if (sain.delaiAnnulationHeures !== undefined) { const h = parseFloat(sain.delaiAnnulationHeures); sain.delaiAnnulationHeures = Number.isFinite(h) && h >= 0 ? Math.min(h, 720) : 0; }
    if (sain.modeDelaiDepasse !== undefined) sain.modeDelaiDepasse = sain.modeDelaiDepasse === "accepter" ? "accepter" : "refuser";
    ['messageAccueilSupplementaire', 'messageAccueilSupplementaireEn'].forEach((k) => { if (sain[k] !== undefined) sain[k] = String(sain[k] == null ? '' : sain[k]).trim().slice(0, 600); });
    if (sain.listesDatesHeures !== undefined) sain.listesDatesHeures = !(sain.listesDatesHeures === false || sain.listesDatesHeures === "false" || sain.listesDatesHeures === 0);
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
    // Etape 62 : un rendez-vous a venir ne peut passer a "Confirmé" que si le creneau n'est pas deja pris par un
    // AUTRE rendez-vous confirme (un "Nouvelle" ne bloquant plus rien, le conflit est possible).
    if (newStatus === "Confirmé" && appt.statut !== "Confirmé" && appt.source !== "simulateur" && new Date(appt.dateISO).getTime() > Date.now()) {
      if (!isSlotFreePour(new Date(appt.dateISO), appt.dureeMinutes || 30, appt.praticienId || null)) {
        return { erreur: "occupe", message: "Ce créneau est déjà pris par un autre rendez-vous confirmé : déplacez ce rendez-vous (bouton Modifier) avant de le confirmer." };
      }
    }
    applyStatusChange(appt, newStatus, raisonAnnulation);
    return appt;
  }

  // Etape 61 : la GERANTE deplace un rendez-vous depuis /admin. `opts` = { date: "AAAA-MM-JJ", heure: "HH:MM"
  // (heure murale du fuseau du marchand), praticienId?, horsHoraires?, par? }. Refuse un creneau passe, un jour
  // ferme / hors horaires / dans la pause (sauf `horsHoraires`) et TOUJOURS un creneau deja occupe par un autre
  // rendez-vous. Remet le rappel a zero (le rappel de la veille repart pour le nouvel horaire) et garde la trace.
  function deplacerAppointment(apptId, opts) {
    if (!state) return { erreur: "indisponible", message: "Service indisponible." };
    opts = opts || {};
    const appt = rdvParId(apptId);
    if (!appt) return { erreur: "introuvable", message: "Rendez-vous introuvable." };
    if (ACTIFS_STATUSES_RDV.indexOf(appt.statut) === -1) {
      return { erreur: "statut", message: "Seul un rendez-vous « Nouvelle » ou « Confirmé » peut être déplacé." };
    }
    const m = String(opts.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const h = String(opts.heure || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m || !h) return { erreur: "format", message: "Date (AAAA-MM-JJ) et heure (HH:MM) requises." };
    const debut = sh.dateDepuisPartiesFuseau(Number(m[1]), Number(m[2]), Number(m[3]), Number(h[1]), Number(h[2]), fz());
    const pp = sh.partiesFuseau(debut, fz());
    if (pp.annee !== Number(m[1]) || pp.mois !== Number(m[2]) || pp.jour !== Number(m[3]) || pp.heure !== Number(h[1]) || pp.minute !== Number(h[2])) {
      return { erreur: "format", message: "Date ou heure invalide." };
    }
    if (debut.getTime() <= Date.now()) return { erreur: "passe", message: "Le nouveau créneau doit être dans le futur." };
    const duree = appt.dureeMinutes || 30;
    const dateOnly = startOfDay(debut);

    if (!opts.horsHoraires) {
      const horaire = horaireDuJour(dateOnly);
      if (!horaire || !horaire.ouvert) return { erreur: "ferme", message: "L'établissement est fermé ce jour-là (cochez « Autoriser hors horaires d'ouverture » pour forcer)." };
      const ouvre = combineDateHeureStr(dateOnly, horaire.debut);
      const ferme = combineDateHeureStr(dateOnly, horaire.fin);
      if (debut.getTime() < ouvre.getTime() || debut.getTime() + duree * 60000 > ferme.getTime()) {
        return { erreur: "horaires", message: "Hors des horaires d'ouverture de ce jour (" + horaire.debut + " – " + horaire.fin + ") : le soin doit se terminer avant la fermeture." };
      }
      if (chevauchePause(dateOnly, horaire, debut, duree)) {
        return { erreur: "pause", message: "Ce créneau chevauche la pause (" + horaire.pauseDebut + " – " + horaire.pauseFin + ")." };
      }
    }

    const praticiens = getPraticiens();
    if (opts.praticienId && praticiens.length > 1 && !praticiens.some((x) => x.id === opts.praticienId)) {
      return { erreur: "praticien", message: "Praticien inconnu." };
    }
    let praticienId = (praticiens.length > 1 ? (opts.praticienId || appt.praticienId) : null) || null;
    ignorerApptId = appt.id;
    try {
      if (praticienId) {
        if (!isSlotFreePour(debut, duree, praticienId)) return { erreur: "occupe", message: "Ce créneau est déjà occupé par un autre rendez-vous." };
      } else {
        if (!isSlotFreePour(debut, duree, null)) return { erreur: "occupe", message: "Ce créneau est déjà occupé par un autre rendez-vous." };
        if (praticiens.length > 1) praticienId = choisirPraticienLibre(debut, duree);
      }
    } finally {
      ignorerApptId = null;
    }

    const ancienISO = appt.dateISO;
    appt.dateISO = debut.toISOString();
    if (praticiens.length > 1) { appt.praticienId = praticienId || null; appt.praticienNom = praticienNomParId(praticienId); }
    appt.rappelEnvoye = false; appt.rappelTentatives = 0; appt.rappelErreur = null; appt.rappelCanal = null;
    appt.rappelDerniereTentativeISO = null; appt.rappelProchaineTentativeISO = null; appt.rappelEnvoyeISO = null;
    if (!Array.isArray(appt.historiqueDeplacements)) appt.historiqueDeplacements = [];
    appt.historiqueDeplacements.push({ deISO: ancienISO, versISO: appt.dateISO, leISO: new Date().toISOString(), par: opts.par || null });
    saveState();
    return { appt };
  }

  // Lecture d'un rendez-vous par id (copie), y compris un rendez-vous du Simulateur : utilise par le pont
  // IzyFacture (server.js) qui doit relire l'etat courant apres chaque appel reseau.
  function getAppointmentById(apptId) {
    if (!state) return null;
    const appt = state.appointments.filter((a) => a.id === Number(apptId))[0];
    return appt ? Object.assign({}, appt) : null;
  }

  // Enregistre sur le rendez-vous le resultat d'un appel a IzyFacture (meme role que dans conversation.js
  // pour les commandes). Retourne le rendez-vous mis a jour, ou null s'il n'existe plus.
  function enregistrerEtatIzyFacture(apptId, patch) {
    if (!state) return null;
    const appt = state.appointments.filter((a) => a.id === Number(apptId))[0];
    if (!appt) return null;
    Object.assign(appt, patch);
    saveState();
    return appt;
  }

  return {
    type: "service",
    init,
    balayerSessions: () => persistance.balayer(),
    getAppointmentById,
    enregistrerEtatIzyFacture,
    handleMessage,
    getAppointments,
    getServices,
    getSettings,
    updateSettings,
    updateServices,
    deplacerAppointment,
    updateAppointmentStatus,
    getConversationsEnAttente,
    repondreConversationHumain,
    getEtatSession,
    getChoixJours,
    getChoixHeures,
    nbRdvsAVenir,
    detailRdvsAVenir,
    definirLangueSession,
    reponseDeReprise,
    estEnPauseHumain,
    langueDeSession,
    handleMessageSimulateur,
    resetSimulateur,
    getTableauDeBord,
    envoyerRappelsDuJour
  };
}

module.exports = createServiceEngine;
