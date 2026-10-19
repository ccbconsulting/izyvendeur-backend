// IzyVendeur - Routage d'un marchand HYBRIDE (Etape 47, generalise a TROIS volets a l'Etape 66) : un meme
// numero WhatsApp, jusqu'a trois volets (catalogue = produits, service = rendez-vous, hebergement = chambres, transport = billets, Etape 74)
// servis par autant de moteurs distincts.
//
// Le routeur ne remplace aucun moteur : il decide, pour chaque message d'un client, a QUEL moteur le donner,
// et gere seulement ce qui est commun aux deux volets :
//   - la porte de langue (une seule fois, puis la langue est imposee aux deux moteurs) ;
//   - le menu a deux ou trois boutons « produits / rendez-vous / chambres » juste apres le choix de langue ;
//   - les paniers separes : chaque moteur garde sa propre session, un client peut passer d'un volet a l'autre
//     sans rien perdre dans l'autre ;
//   - la pause « conversation avec un humain » : tant qu'elle est en cours dans un volet, le client y reste
//     et le message est laisse au moteur (qui reste silencieux), jamais intercepte par le menu.
//
// Un marchand NON hybride n'utilise jamais ce module : son webhook est strictement celui d'avant.
//
// Aucune dependance reseau ici : le routeur recoit les moteurs en parametre et RENVOIE une decision, que
// server.js execute (envoi du menu a deux boutons, appel du bon moteur). Ainsi il se teste seul.

const sh = require("./shared");
const sessionsPersistantes = require("./sessionsPersistantes");

// Jetons produits par server.js a partir d'un clic sur l'un des deux boutons du menu (voir
// resoudreTexteInteractif) : evite de dependre de la langue du titre du bouton.
const JETON_VOLET_CATALOGUE = "__volet_catalogue__";
const JETON_VOLET_SERVICE = "__volet_service__";
const JETON_VOLET_HEBERGEMENT = "__volet_hebergement__";
const JETON_VOLET_TRANSPORT = "__volet_transport__"; // Etape 74
const VOLETS_CONNUS = ["catalogue", "service", "hebergement", "transport"];

function norm(texte) {
  return String(texte || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Expressions reconnues (apres normalisation : minuscules, sans accents). Volontairement ETROITES pour les
// bascules automatiques en cours de conversation (un faux declenchement serait pire qu'un oubli : le client
// dispose toujours de la phrase « menu principal »).
const RE_MENU_PRINCIPAL = /\b(menu principal|main menu|retour au menu|back to (the )?menu|changer de rubrique|autre rubrique|change section)\b/;
// Bascules AUTOMATIQUES en cours de conversation : mots tres explicites seulement (« reserver cet article »
// ne doit pas envoyer un client du catalogue vers les rendez-vous, ni « quels produits utilisez-vous ? » un
// client des rendez-vous vers le catalogue).
const RE_VEUT_RDV = /\b(rendez[\s-]?vous|rdv|appointment|booking)\b/;
const RE_VEUT_PRODUITS = /\b(commander|acheter|panier|catalogue|buy|cart|shop)\b/;
const RE_CHOIX_PRODUITS = /\b(produits?|articles?|boutique|acheter|achat|commander|catalogue|shop|buy|products?|items?|order)\b/;
const RE_CHOIX_RDV = /\b(rendez[\s-]?vous|rdv|reserver|reservation|soins?|prestations?|services?|appointments?|booking|book)\b/;
// Volet hebergement (Etape 66). Dans les bascules AUTOMATIQUES, « reservation » / « booking » seuls ne suffisent
// pas (ils peuvent viser une chambre OU un rendez-vous) : on exige « rendez-vous / rdv / appointment » pour le
// volet service des qu'un volet hebergement existe, et un couple verbe de reservation + chambre pour les chambres.
const RE_RDV_STRICT = /\b(rendez[\s-]?vous|rdv|appointments?)\b/;
const RE_VEUT_HEB_AUTO = /\b(chambres?|rooms?|suites?)\b.*\b(disponibles?|available|libres?|reserver|book)\b|\b(reserver|book|booking|reservation|louer|rent)\b.*\b(chambres?|rooms?|suites?)\b|\b(nuitees?|hebergement|accommodation)\b/;
const RE_CHOIX_HEB = /\b(chambres?|rooms?|suites?|hotel|hebergement|sejour|nuitees?|nuits?|nights?|stay|accommodation|lodging)\b/;
// Volet transport (Etape 74) : billets, trajets, navettes. Dans les bascules AUTOMATIQUES, seuls les mots tres explicites comptent.
const RE_VEUT_TRANSPORT_AUTO = /\b(billets?|tickets?|navette|shuttle|train|trajets?)\b/;
const RE_CHOIX_TRANSPORT = /\b(billets?|tickets?|train|voyages?|voyager|trajets?|navette|shuttle|cars?|bus|transport|travel|trip)\b/;
// Lien de commande genere par /admin (« Bonjour, je suis intéressé(e) par : X » / « Hello, I'm interested in: X »).
const RE_LIEN_COMMANDE = /(int[eé]ress[eé](\(e\))? par\s*:|interested in\s*:)/i;

function libelleBoutons(langue, volets) {
  const en = langue === "en";
  const titres = {
    catalogue: en ? "🛍️ Our products" : "🛍️ Nos produits",
    service: en ? "📅 Appointments" : "📅 Rendez-vous",
    hebergement: en ? "🛏️ Rooms" : "🛏️ Chambres",
    transport: en ? "🎫 Tickets" : "🎫 Billets"
  };
  return volets.map((v) => ({ volet: v, title: titres[v] }));
}

function texteMenu(langue, volets) {
  const en = langue === "en";
  const lignes = volets.map((v, i) => {
    const num = (i + 1) + "️⃣ ";
    if (v === "catalogue") return num + (en ? "Browse our products" : "Voir nos produits");
    if (v === "hebergement") return num + (en ? "Book a room" : "Réserver une chambre");
    if (v === "transport") return num + (en ? "Book a ticket" : "Réserver un billet");
    return num + (en ? "Book an appointment" : "Prendre un rendez-vous");
  });
  return (en ? "What would you like to do?" : "Que souhaitez-vous faire ?") + "\n" + lignes.join("\n");
}

function texteIndiceMenu(langue) {
  return langue === "en"
    ? "\n\n(To come back to this choice at any time, type \"main menu\".)"
    : "\n\n(Pour revenir à ce choix à tout moment, écrivez « menu principal ».)";
}

// `moteurs` : { catalogue?, service?, hebergement? } (au moins deux pour un marchand hybride) ;
// `principal` : "catalogue" | "service" | "hebergement" (le `type` du marchand : le volet d'ou part la porte de langue et celui
// qui recoit une demande d'humain avant tout choix) ; `deps.journaliser(tel, de, texte)` (facultatif).
function creerRouteur(moteurs, principal, deps) {
  const etats = {}; // telephone -> { etape: "langue" | "menu" | "volet", volet, langue, texteInitial }
  // Etape 72 : etat de routage sauvegarde (voir sessionsPersistantes.js) pour survivre a un redemarrage. Sans `deps.cle`
  // (anciens appels, tests unitaires), rien n'est sauvegarde. Une porte de langue laissee ouverte plus de 24 h est oubliee.
  const persistance = sessionsPersistantes.creer({
    cle: (deps && deps.cle) || "_routeur_sans_cle", sessions: etats, ignorer: ["SIMULATEUR"],
    regle: (e, age) => {
      if (age > sessionsPersistantes.DUREE_MAX_JOURS * sessionsPersistantes.JOUR_MS) return null;
      if (e.etape === "langue" && age > sessionsPersistantes.JOUR_MS) return null;
      return e;
    }
  });
  const persister = !!(deps && deps.cle);
  const journaliser = (deps && deps.journaliser) || (() => {});

  function types() { return Object.keys(moteurs).filter((t) => moteurs[t]); }

  // Un volet est PROPOSE seulement s'il contient quelque chose a montrer : un second volet fraichement
  // accorde mais encore vide (aucun service / aucun article saisi) ne doit pas piéger les clients dans un
  // menu sans contenu. Si un seul volet est utilisable, le menu est saute et le client y est conduit
  // directement ; si aucun ne l'est, on retombe sur le volet principal.
  function contenu(type) {
    const m = moteurs[type];
    if (!m) return 0;
    try {
      if (type === "catalogue") return (m.getCatalog() || []).length;
      if (type === "hebergement") return (m.getChambres() || []).length;
      if (type === "transport") return (m.getLignes() || []).some((l) => l.actif !== false) ? (m.getDeparts() || []).filter((d) => d.actif !== false).length : 0;
      return (m.getServices() || []).length;
    } catch (e) { return 0; }
  }
  function voletsUtilisables() {
    const ordre = [principal].concat(types().filter((t) => t !== principal));
    const ok = ordre.filter((t) => contenu(t) > 0);
    return ok.length ? ok : [principal];
  }

  function voletActif(tel) {
    const e = etats[tel];
    return e && e.etape === "volet" && moteurs[e.volet] ? e.volet : principal;
  }

  function langueConnue(tel) {
    const e = etats[tel];
    if (e && e.langue) return e.langue;
    for (const t of types()) {
      const l = moteurs[t].langueDeSession && moteurs[t].langueDeSession(tel);
      if (l) return l;
    }
    return "fr";
  }

  function imposerLangue(tel, langue) {
    types().forEach((t) => { if (moteurs[t].definirLangueSession) moteurs[t].definirLangueSession(tel, langue); });
    if (etats[tel]) etats[tel].langue = langue;
  }

  function stageDe(type, tel) {
    const m = moteurs[type];
    const etat = m && m.getEtatSession ? m.getEtatSession(tel) : null;
    return etat ? etat.stage : null;
  }

  // Decision : confier ce message au moteur d'un volet.
  function versMoteur(tel, volet, texte, options) {
    const e = etats[tel];
    // Le moteur cible doit parler la langue deja choisie par le client (peut avoir change dans l'autre volet).
    const langue = (e && e.langue) || langueConnue(tel);
    if (moteurs[volet].definirLangueSession && (moteurs[volet].langueDeSession && moteurs[volet].langueDeSession(tel)) !== langue) {
      moteurs[volet].definirLangueSession(tel, langue);
    }
    etats[tel] = Object.assign(etats[tel] || {}, { etape: "volet", volet, langue });
    return { type: "moteur", volet, texte, suffixe: (options && options.suffixe) || null, sansJournalClient: !!(options && options.sansJournalClient) };
  }

  function decisionMenu(tel, prefixe) {
    const langue = langueConnue(tel);
    const volets = voletsUtilisables();
    etats[tel] = Object.assign(etats[tel] || {}, { etape: "menu", langue });
    const corps = (prefixe ? prefixe + "\n\n" : "") + texteMenu(langue, volets);
    journaliser(tel, "bot", corps);
    return { type: "menu", texte: corps, boutons: libelleBoutons(langue, volets) };
  }

  function salutation(langue) { return langue === "en" ? "Hello" : "Bonjour"; }

  // Entree : un message du client (deja ramene a du texte, voir resoudreTexteInteractif). Renvoie
  //   { type: "moteur", volet, texte, suffixe }  -> server.js appelle moteurs[volet].handleMessage(tel, texte)
  //                                                  et ajoute `suffixe` a la reponse s'il y en a une ;
  //   { type: "reprise", volet, reponse, suffixe } -> server.js renvoie `reponse` (derniere question du moteur,
  //                                                  menus cliquables recalcules) sans appeler handleMessage ;
  //   { type: "menu", texte, boutons }            -> server.js envoie le menu a deux boutons.
  function traiter(tel, texte) {
    let e = etats[tel];
    const brut = String(texte || "");

    // ---- Premier contact : la porte de langue du moteur principal (inchangee) ----
    if (!e) {
      // Un client qui a DEJA une conversation en cours dans un moteur (ex: second volet accorde pendant qu'il
      // discutait) continue la ou il en etait, sans repasser par la porte de langue.
      for (const t of [principal].concat(types().filter((x) => x !== principal))) {
        const l = moteurs[t].langueDeSession && moteurs[t].langueDeSession(tel);
        if (l) { etats[tel] = { etape: "volet", volet: t, langue: l }; return versMoteur(tel, t, brut); }
      }
      etats[tel] = { etape: "langue", texteInitial: brut, langue: null };
      return { type: "moteur", volet: principal, texte: brut, suffixe: null };
    }

    // ---- Reponse a la porte de langue ----
    if (e.etape === "langue") {
      const choix = sh.detecterChoixLangueInitial(brut);
      const langue = choix || "fr";
      imposerLangue(tel, langue);
      e = etats[tel];
      const texteInitial = e.texteInitial || "";
      delete e.texteInitial;
      // Demande d'humain tapee a la place du choix de langue : le moteur principal gere pause et alerte.
      if (!choix && sh.demandeUnHumain(brut)) return versMoteur(tel, principal, brut);
      const volets = voletsUtilisables();
      // Un seul volet utilisable : pas de menu, on y va (avec le texte d'origine s'il en avait un).
      if (volets.length === 1) {
        journaliser(tel, "client", brut);
        return versMoteur(tel, volets[0], texteInitial || salutation(langue), { sansJournalClient: true });
      }
      // Le message d'origine disait deja ce que veut le client : on l'y conduit directement.
      if (texteInitial) {
        if (volets.indexOf("catalogue") !== -1 && RE_LIEN_COMMANDE.test(texteInitial)) {
          journaliser(tel, "client", brut);
          return versMoteur(tel, "catalogue", texteInitial, { sansJournalClient: true });
        }
        const ni = norm(texteInitial);
        const avecHeb = volets.indexOf("hebergement") !== -1;
        const avecTransport = volets.indexOf("transport") !== -1;
        const avecAutres = avecHeb || avecTransport;
        if (avecTransport && RE_VEUT_TRANSPORT_AUTO.test(ni) && !RE_RDV_STRICT.test(ni) && !RE_VEUT_PRODUITS.test(ni) && !(avecHeb && RE_VEUT_HEB_AUTO.test(ni))) {
          journaliser(tel, "client", brut);
          return versMoteur(tel, "transport", texteInitial, { sansJournalClient: true });
        }
        if (avecHeb && RE_VEUT_HEB_AUTO.test(ni) && !RE_RDV_STRICT.test(ni) && !RE_VEUT_PRODUITS.test(ni)) {
          journaliser(tel, "client", brut);
          return versMoteur(tel, "hebergement", texteInitial, { sansJournalClient: true });
        }
        if (volets.indexOf("service") !== -1 && (avecAutres ? RE_RDV_STRICT.test(ni) : RE_VEUT_RDV.test(ni)) && !RE_VEUT_PRODUITS.test(ni) && !(avecHeb && RE_VEUT_HEB_AUTO.test(ni))) {
          journaliser(tel, "client", brut);
          return versMoteur(tel, "service", texteInitial, { sansJournalClient: true });
        }
      }
      journaliser(tel, "client", brut);
      return decisionMenu(tel);
    }

    // ---- Menu a deux boutons : choix du volet ----
    if (e.etape === "menu") {
      journaliser(tel, "client", brut);
      const langue = e.langue || langueConnue(tel);
      const n = norm(brut);

      const changement = sh.detecterChangementLangue(brut);
      if (changement) {
        imposerLangue(tel, changement);
        return decisionMenu(tel, changement === "en" ? "Sure, I'll continue in English. 🇬🇧" : "Très bien, je continue en français. 🇫🇷");
      }
      if (sh.demandeUnHumain(brut)) {
        // L'alerte au marchand et la pause sont gerees par le moteur principal ; le client y reste.
        // (Le moteur journalise lui-meme ce message : on ne le journalise pas deux fois.)
        etats[tel].etape = "volet"; etats[tel].volet = principal;
        return { type: "moteur", volet: principal, texte: brut, suffixe: null, sansJournalClient: true };
      }

      const volets = voletsUtilisables();
      let choisi = null;
      if (brut === JETON_VOLET_CATALOGUE) choisi = "catalogue";
      else if (brut === JETON_VOLET_SERVICE) choisi = "service";
      else if (brut === JETON_VOLET_HEBERGEMENT) choisi = "hebergement";
      else if (brut === JETON_VOLET_TRANSPORT) choisi = "transport";
      else if (/^\s*[1-4]\s*$/.test(brut)) choisi = volets[Number(brut.trim()) - 1] || null;
      else {
        // Un mot n'est retenu que s'il designe UN SEUL des volets proposes. Quand un volet hebergement est
        // propose, « reserver / reservation / book » seuls ne designent plus le volet rendez-vous.
        const avecHeb = volets.indexOf("hebergement") !== -1;
        const avecTransport = volets.indexOf("transport") !== -1;
        const avecAutres = avecHeb || avecTransport;
        const trouves = [];
        if (volets.indexOf("catalogue") !== -1 && RE_CHOIX_PRODUITS.test(n)) trouves.push("catalogue");
        if (volets.indexOf("service") !== -1 && (avecAutres ? RE_RDV_STRICT.test(n) || /\b(soins?|prestations?|services?)\b/.test(n) : RE_CHOIX_RDV.test(n))) trouves.push("service");
        if (avecHeb && (RE_CHOIX_HEB.test(n) || (volets.indexOf("service") === -1 && !avecTransport && /\b(reserver|reservation|book|booking)\b/.test(n)))) trouves.push("hebergement");
        if (avecTransport && (RE_CHOIX_TRANSPORT.test(n) || (volets.indexOf("service") === -1 && !avecHeb && /\b(reserver|reservation|book|booking)\b/.test(n)))) trouves.push("transport");
        if (trouves.length === 1) choisi = trouves[0];
      }
      if (!choisi || volets.indexOf(choisi) === -1) {
        return decisionMenu(tel, langue === "en" ? "Sorry, I didn't catch that. Please choose:" : "Désolé, je n'ai pas compris. Choisissez :");
      }
      // Le client revient dans un volet ou son parcours est EN COURS (panier a valider, nom attendu...) : on lui
      // redonne exactement sa derniere question, SANS rien envoyer au moteur (une phrase synthetique serait
      // prise pour sa reponse - « Bonjour » comme nom de rendez-vous, par exemple).
      const reprise = moteurs[choisi].reponseDeReprise ? moteurs[choisi].reponseDeReprise(tel) : null;
      if (reprise) {
        const d = versMoteur(tel, choisi, null, { suffixe: texteIndiceMenu(langue) });
        journaliser(tel, "bot", reprise);
        return Object.assign(d, { type: "reprise", reponse: reprise });
      }
      // Sinon le clic est un simple choix : le moteur recoit une salutation, qui l'amene a son accueil/liste.
      return versMoteur(tel, choisi, salutation(langue), { suffixe: texteIndiceMenu(langue), sansJournalClient: true });
    }

    // ---- Dans un volet ----
    const volet = voletActif(tel);
    const m = moteurs[volet];

    // Pause « humain » en cours : on laisse faire le moteur (silence) sans jamais intercepter.
    if (m.estEnPauseHumain && m.estEnPauseHumain(tel)) return { type: "moteur", volet, texte: brut, suffixe: null };

    // La langue peut avoir change DANS ce volet (« in English ») : on la releve avant tout passage a l'autre.
    const langueMoteur = m.langueDeSession && m.langueDeSession(tel);
    if (langueMoteur) etats[tel].langue = langueMoteur;

    const n = norm(brut);
    const volets = voletsUtilisables();

    if (RE_MENU_PRINCIPAL.test(n) && volets.length > 1) {
      journaliser(tel, "client", brut);
      return decisionMenu(tel);
    }

    // Bascules automatiques, uniquement quand le moteur actuel n'attend aucune reponse precise (stage "idle").
    // On ne bascule que si le message designe UN SEUL des autres volets ; en cas de doute on reste ou l'on est.
    const autres = volets.filter((v) => v !== volet);
    if (autres.length && stageDe(volet, tel) === "idle") {
      const avecHeb = volets.indexOf("hebergement") !== -1;
      const avecAutres = avecHeb || volets.indexOf("transport") !== -1;
      const cibles = [];
      for (const v of autres) {
        if (v === "transport") {
          if (RE_VEUT_TRANSPORT_AUTO.test(n) && !RE_RDV_STRICT.test(n) && !RE_VEUT_PRODUITS.test(n) && !RE_VEUT_HEB_AUTO.test(n)) cibles.push(v);
        } else if (v === "service") {
          if (avecAutres) { if (RE_RDV_STRICT.test(n) && !RE_VEUT_PRODUITS.test(n) && !RE_VEUT_HEB_AUTO.test(n)) cibles.push(v); }
          else if (sh.detecterIntentionRdv(brut) || (RE_VEUT_RDV.test(n) && !RE_VEUT_PRODUITS.test(n))) cibles.push(v);
        } else if (v === "catalogue") {
          if (RE_VEUT_PRODUITS.test(n) && !RE_VEUT_RDV.test(n) && !RE_VEUT_HEB_AUTO.test(n)) cibles.push(v);
        } else if (v === "hebergement") {
          if (RE_VEUT_HEB_AUTO.test(n) && !RE_RDV_STRICT.test(n) && !RE_VEUT_PRODUITS.test(n)) cibles.push(v);
        }
      }
      if (cibles.length === 1) return versMoteur(tel, cibles[0], brut);
    }

    return { type: "moteur", volet, texte: brut, suffixe: null };
  }

  // Etape 70 : le client touche « Mon panier / Mon rendez-vous / Ma reservation » dans le menu principal : il est conduit
  // dans ce volet SANS rien envoyer au moteur. `viaMenu` = vrai : il reste a l'etape « menu », et son prochain message
  // (le jeton du volet) passe par la logique habituelle de reprise de sa derniere question.
  function entrerDansVolet(tel, volet, viaMenu) {
    if (!moteurs[volet]) return false;
    if (viaMenu) {
      etats[tel] = Object.assign(etats[tel] || {}, { etape: "menu", langue: (etats[tel] && etats[tel].langue) || langueConnue(tel) });
      return true;
    }
    versMoteur(tel, volet, "", {});
    return true;
  }

  // Efface l'etat de routage d'un numero (bouton « Reinitialiser » du Simulateur de /admin).
  function oublier(tel) { delete etats[tel]; }

  return {
    traiter: (tel, brut) => { const d = traiter(tel, brut); if (persister) persistance.enregistrer(tel); return d; },
    oublier: (tel) => { oublier(tel); if (persister) persistance.enregistrer(tel); },
    entrerDansVolet: (tel, volet, viaMenu) => { const r = entrerDansVolet(tel, volet, viaMenu); if (persister) persistance.enregistrer(tel); return r; },
    voletActif, voletsUtilisables,
    etatDe: (tel) => (etats[tel] ? Object.assign({}, etats[tel]) : null),
    chargerSessions: () => (persister ? persistance.charger() : Promise.resolve(0)),
    balayerSessions: () => { if (persister) persistance.balayer(); }
  };
}

module.exports = { creerRouteur, JETON_VOLET_CATALOGUE, JETON_VOLET_SERVICE, JETON_VOLET_HEBERGEMENT, JETON_VOLET_TRANSPORT, VOLETS_CONNUS };
