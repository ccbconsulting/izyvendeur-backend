// IzyVendeur - Routage d'un marchand HYBRIDE (Etape 47) : un meme numero WhatsApp, deux volets
// (catalogue = produits, service = rendez-vous) servis par DEUX moteurs distincts.
//
// Le routeur ne remplace aucun moteur : il decide, pour chaque message d'un client, a QUEL moteur le donner,
// et gere seulement ce qui est commun aux deux volets :
//   - la porte de langue (une seule fois, puis la langue est imposee aux deux moteurs) ;
//   - le menu a deux boutons « produits / rendez-vous » juste apres le choix de langue ;
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

// Jetons produits par server.js a partir d'un clic sur l'un des deux boutons du menu (voir
// resoudreTexteInteractif) : evite de dependre de la langue du titre du bouton.
const JETON_VOLET_CATALOGUE = "__volet_catalogue__";
const JETON_VOLET_SERVICE = "__volet_service__";

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
// Lien de commande genere par /admin (« Bonjour, je suis intéressé(e) par : X » / « Hello, I'm interested in: X »).
const RE_LIEN_COMMANDE = /(int[eé]ress[eé](\(e\))? par\s*:|interested in\s*:)/i;

function libelleBoutons(langue, volets) {
  const en = langue === "en";
  const titres = {
    catalogue: en ? "🛍️ Our products" : "🛍️ Nos produits",
    service: en ? "📅 Appointments" : "📅 Rendez-vous"
  };
  return volets.map((v) => ({ volet: v, title: titres[v] }));
}

function texteMenu(langue, volets) {
  const en = langue === "en";
  const lignes = volets.map((v, i) => {
    const num = (i + 1) + "️⃣ ";
    if (v === "catalogue") return num + (en ? "Browse our products" : "Voir nos produits");
    return num + (en ? "Book an appointment" : "Prendre un rendez-vous");
  });
  return (en ? "What would you like to do?" : "Que souhaitez-vous faire ?") + "\n" + lignes.join("\n");
}

function texteIndiceMenu(langue) {
  return langue === "en"
    ? "\n\n(To come back to this choice at any time, type \"main menu\".)"
    : "\n\n(Pour revenir à ce choix à tout moment, écrivez « menu principal ».)";
}

// `moteurs` : { catalogue?: engine, service?: engine } (au moins les deux pour un marchand hybride) ;
// `principal` : "catalogue" | "service" (le `type` du marchand : le volet d'ou part la porte de langue et celui
// qui recoit une demande d'humain avant tout choix) ; `deps.journaliser(tel, de, texte)` (facultatif).
function creerRouteur(moteurs, principal, deps) {
  const etats = {}; // telephone -> { etape: "langue" | "menu" | "volet", volet, langue, texteInitial }
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
      return type === "catalogue" ? (m.getCatalog() || []).length : (m.getServices() || []).length;
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
        if (volets.indexOf("service") !== -1 && RE_VEUT_RDV.test(norm(texteInitial)) && !RE_VEUT_PRODUITS.test(norm(texteInitial))) {
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
      else if (/^\s*[12]\s*$/.test(brut)) choisi = volets[Number(brut.trim()) - 1] || null;
      else {
        const p = RE_CHOIX_PRODUITS.test(n), r = RE_CHOIX_RDV.test(n);
        if (p && !r) choisi = "catalogue";
        else if (r && !p) choisi = "service";
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
    const autre = volets.find((v) => v !== volet);
    if (autre && stageDe(volet, tel) === "idle") {
      const intention = sh.detecterIntentionRdv(brut);
      if (autre === "service" && (intention || (RE_VEUT_RDV.test(n) && !RE_VEUT_PRODUITS.test(n)))) {
        return versMoteur(tel, "service", brut);
      }
      if (autre === "catalogue" && RE_VEUT_PRODUITS.test(n) && !RE_VEUT_RDV.test(n)) {
        return versMoteur(tel, "catalogue", brut);
      }
    }

    return { type: "moteur", volet, texte: brut, suffixe: null };
  }

  return { traiter, voletActif, voletsUtilisables, etatDe: (tel) => (etats[tel] ? Object.assign({}, etats[tel]) : null) };
}

module.exports = { creerRouteur, JETON_VOLET_CATALOGUE, JETON_VOLET_SERVICE };
