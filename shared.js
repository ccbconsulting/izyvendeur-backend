// IzyVendeur - Petits utilitaires partages entre les moteurs de conversation (catalogue et service).
// Regroupes ici pour eviter de dupliquer (et de faire diverger accidentellement) la meme logique dans
// conversation.js et conversationService.js.

function formatFcfa(n) {
  return (n || 0).toLocaleString("fr-FR") + " FCFA";
}

function piocheParmi(liste) {
  return liste[Math.floor(Math.random() * liste.length)];
}

function parseAffirmative(text) {
  const t = text.toLowerCase().trim();
  if (t === "o") return true;
  return /^(oui|ouais|ouep|d['’]accord|daccord|ok(?:ay)?|yes|exact(?:ement)?|parfait|je\s*confirme|confirm(?:e|é)?|c['’]est\s*(?:ça|bon)|banco|allons[- ]y|top)\b/.test(t);
}

function parseNegative(text) {
  const t = text.toLowerCase().trim();
  if (t === "n") return true;
  return /^(non|nan+|no|nope|rien\s*d['’]autre|rien\s*de\s*plus|c['’]est\s*tout|[çc]a\s*suffit|stop|arr[êe]te[rz]?|n[ée]gatif)\b/.test(t);
}

// Reconnait les phrases par lesquelles un client signale qu'il veut abandonner la selection en cours
// sans en nommer une nouvelle ("je veux autre chose", "un autre service"...).
function parseWantsSomethingElse(text) {
  const t = text.toLowerCase();
  return /\b(autre\s+chose|un\s+autre\s+article|un\s+autre\s+produit|un\s+autre\s+service|autre\s+article|autre\s+produit|autre\s+service|pas\s+celui[\s-]l[àa]|pas\s+ça|pas\s+ca|change(?:r)?\s+d['’]article|change(?:r)?\s+d['’]avis|oublie[rz]?\s+(?:ça|ca|cela)|annule[rz]?\s+(?:ça|ca|cela)?|laisse\s+tomber|recommen[cç]ons|recommencer)\b/.test(t);
}

function echapperHtml(valeur) {
  return String(valeur == null ? "" : valeur)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------- Bilingue (francais / anglais) ----------------
// Le Cameroun etant bilingue, chaque client choisit sa langue en tout debut de conversation (porte geree
// par le moteur - voir conversation.js/conversationService.js, handleMessage) et peut en changer a tout
// moment via une phrase reconnue ci-dessous. Le reste du moteur produit alors ses reponses dans la langue
// de LA SESSION (session.langue, "fr" ou "en") via `t(session, texteFr, texteEn)` plutot que du texte fixe.
// Les noms d'articles/services/categories restent eux tels que le marchand les a saisis (pas de champ nom
// anglais separe pour l'instant) - seules les PHRASES DU BOT sont traduites.

function langueSession(session) {
  return session && session.langue === "en" ? "en" : "fr"; // "fr" par defaut (comportement historique)
}

function t(session, texteFr, texteEn) {
  return langueSession(session) === "en" ? texteEn : texteFr;
}

function normaliserPourRechercheLangue(texte) {
  return String(texte || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Reconnait une demande explicite de CHANGER de langue en cours de route, quel que soit le stade de la
// conversation (meme principe que demandeUnHumain/demandeVoirPanier ci-dessus). Renvoie "fr"/"en"/null.
const MOTS_CLES_VERS_ANGLAIS = ["in english", "speak english", "en anglais", "parle anglais", "switch to english", "english please", "passe en anglais"];
const MOTS_CLES_VERS_FRANCAIS = ["en francais", "parle francais", "switch to french", "in french", "french please", "passe en francais"];

function detecterChangementLangue(texte) {
  const t2 = normaliserPourRechercheLangue(texte);
  if (MOTS_CLES_VERS_ANGLAIS.some((m) => t2.indexOf(normaliserPourRechercheLangue(m)) !== -1)) return "en";
  if (MOTS_CLES_VERS_FRANCAIS.some((m) => t2.indexOf(normaliserPourRechercheLangue(m)) !== -1)) return "fr";
  return null;
}

// Reconnait la reponse du client au tout premier message bilingue de bienvenue ("Repondez FR / Reply EN").
// Volontairement tres permissif (le client peut taper "fr", "français", "1", "en", "english", "2"...).
function detecterChoixLangueInitial(texte) {
  const t2 = normaliserPourRechercheLangue(texte).trim();
  if (["fr", "francais", "french", "1"].indexOf(t2) !== -1) return "fr";
  if (["en", "english", "anglais", "2"].indexOf(t2) !== -1) return "en";
  return null;
}

// Le tout premier message envoye a un nouveau client, AVANT meme de savoir sa langue - forcement bilingue
// par construction. Renvoye une seule fois par session (voir handleMessage), la reponse suivante fixe
// session.langue pour tout le reste de la conversation.
function messageChoixLangue() {
  return "Bienvenue 👋 / Welcome!\nRépondez *FR* pour continuer en français.\nReply *EN* to continue in English.";
}

// ---------------- Mise en relation avec un humain ----------------
// Partage entre conversation.js et conversationService.js : detection de la demande, gestion de la
// pause (10 minutes sans intervention du marchand), et historique - le tout garde EN MEMOIRE (comme les
// sessions de conversation), pas en base de donnees : un redemarrage du serveur remet les compteurs a
// zero, ce qui est un compromis accepte pour l'instant.

const DUREE_PAUSE_HUMAIN_MS = 10 * 60 * 1000; // 10 minutes

function normaliserPourRecherche(texte) {
  return String(texte || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // retire les accents pour une recherche plus tolerante
}

// Bilingue (voir plus haut) : le client peut demander un humain dans l'une ou l'autre langue, quelle que
// soit celle choisie pour le reste de la conversation (une demande urgente ne doit jamais depende d'avoir
// tape le mot-cle dans la "bonne" langue).
const MOTS_CLES_HUMAIN = [
  "parler a un humain", "parler a quelqu'un", "parler a une personne", "vraie personne",
  "personne reelle", "un humain", "une humaine", "un vendeur", "une vendeuse", "un conseiller",
  "une conseillere", "un representant", "une representante", "un agent", "un responsable",
  "le gerant", "la gerante", "le patron", "la patronne", "quelqu'un d'autre", "assistance humaine",
  "parler a un vrai", "un etre humain",
  "talk to a human", "speak to a human", "talk to someone", "speak to someone", "real person",
  "a human being", "human agent", "customer service", "customer support", "talk to an agent",
  "speak to an agent", "the manager", "someone else", "talk to a person", "speak to a person"
];

// Reconnait qu'un client demande a parler a un humain, quel que soit le moment de la conversation.
function demandeUnHumain(texte) {
  const t = normaliserPourRecherche(texte);
  return MOTS_CLES_HUMAIN.some((mot) => t.includes(normaliserPourRecherche(mot)));
}

const MOTS_CLES_PANIER = [
  "panier", "mon panier", "voir mon panier", "voir le panier",
  "cart", "my cart", "view cart", "view my cart", "show cart", "show my cart", "see my cart"
];

// Reconnait qu'un client veut consulter son panier (mot-cle "panier" tape librement, ou bouton "Mon
// panier" - voir server.js), quel que soit le moment du parcours d'achat en cours (voir conversation.js,
// createCatalogEngine.processMessage).
function demandeVoirPanier(texte) {
  const t = normaliserPourRecherche(texte);
  return MOTS_CLES_PANIER.some((mot) => t.includes(normaliserPourRecherche(mot)));
}

// ---------------- Annulation / report d'un rendez-vous (volet service) ----------------
// Reconnait qu'un client, a tout moment de la conversation, veut annuler ou reporter SON rendez-vous
// deja pris (et non pas simplement abandonner une selection en cours - voir parseWantsSomethingElse,
// qui reste utilisee localement dans les etapes de choix). On exige que le client mentionne
// explicitement son rendez-vous ("rendez-vous" / "rdv" / "reservation") pour eviter tout declenchement
// intempestif sur un "annule" ou "je change d'avis" dit dans un tout autre contexte.
function detecterIntentionRdv(texte) {
  const t = normaliserPourRecherche(texte);
  if (!t.trim()) return null;
  const mentionneRdv = /\b(rendez[\s-]?vous|rdv|reservation)\b/.test(t);
  if (!mentionneRdv) return null;
  if (/\b(annuler|annulation|supprime[rz]?|decommande[rz]?)\b/.test(t)) return "annuler";
  if (/\b(reporter|report|reprogramme[rz]?|deplace[rz]?|changer|modifie[rz]?|decale[rz]?)\b/.test(t)) return "reporter";
  return null;
}

// Le message envoye au client UNE SEULE fois, au moment ou la pause commence - bilingue (voir plus haut),
// donc fonction de la session plutot que constante fixe. `estMessageMiseEnRelation` sert au cote appelant
// (server.js) qui a besoin de reconnaitre CE message precis sans connaitre sa langue exacte.
const MESSAGE_MISE_EN_RELATION_FR = "Je vous mets en relation avec un membre de notre équipe, merci de patienter quelques instants 🙏";
const MESSAGE_MISE_EN_RELATION_EN = "I'm connecting you with a member of our team, please hold on for a moment 🙏";

function messageMiseEnRelation(session) {
  return t(session, MESSAGE_MISE_EN_RELATION_FR, MESSAGE_MISE_EN_RELATION_EN);
}

function estMessageMiseEnRelation(texte) {
  return texte === MESSAGE_MISE_EN_RELATION_FR || texte === MESSAGE_MISE_EN_RELATION_EN;
}

// Sert au cote appelant (server.js) qui a besoin de reconnaitre CE message precis (la toute premiere
// porte bilingue, voir messageChoixLangue ci-dessus) pour lui substituer un menu tactile (liste WhatsApp
// Français/English) plutot que de laisser le client taper "FR"/"EN" au clavier - voir
// essayerEnvoyerMenuInteractif. On verifie que le texte SE TERMINE PAR messageChoixLangue() (plutot qu'une
// egalite stricte) car un marchand peut avoir configure un message d'accueil personnalise (voir
// messageAccueilPersonnalise dans conversation.js) qui vient s'ajouter AVANT, dans le meme message -
// messageChoixLangue() lui-meme n'a qu'une seule forme (pas de variante par session, la langue n'est
// justement pas encore connue a ce stade).
function estMessageChoixLangue(texte) {
  return typeof texte === "string" && texte.length > 0 && texte.slice(-messageChoixLangue().length) === messageChoixLangue();
}

// Glissee UNE SEULE fois par client (a la toute premiere reponse REELLE du bot), pour qu'il sache des le
// depart qu'un humain reste accessible sur simple demande - constat remonte par un marchand : un client
// qui n'a jamais utilise ce genre d'assistant ne devine pas spontanement cette option. Ajoutee en suffixe
// du premier message (voir conversation.js / conversationService.js, handleMessage), jamais repetee
// ensuite pour ne pas alourdir la conversation. Bilingue, comme le reste (voir plus haut).
const MENTION_HUMAIN_DISPONIBLE_FR = "\n\n(À tout moment, vous pouvez me demander de vous mettre en relation avec un conseiller si vous préférez échanger avec une personne.)";
const MENTION_HUMAIN_DISPONIBLE_EN = "\n\n(At any time, you can ask me to connect you with a team member if you'd rather speak with a person.)";

function mentionHumainDisponible(session) {
  return t(session, MENTION_HUMAIN_DISPONIBLE_FR, MENTION_HUMAIN_DISPONIBLE_EN);
}

// true si ce message doit rester SANS reponse automatique (pause en cours et delai pas encore ecoule).
// Si le delai de 10 minutes sans reponse du marchand est ecoule, remet automatiquement enAttente a
// false (le bot reprend la main sur CE message) et renvoie false.
function pauseHumainActive(conversationsHumain, telephone) {
  const c = conversationsHumain[telephone];
  if (!c || !c.enAttente) return false;
  const ecouleMs = Date.now() - new Date(c.depuisISO).getTime();
  if (ecouleMs >= DUREE_PAUSE_HUMAIN_MS) {
    c.enAttente = false;
    return false;
  }
  return true;
}

function ajouterMessageHistorique(conversationsHumain, telephone, de, texte) {
  const c = conversationsHumain[telephone];
  if (!c) return;
  c.historique.push({ de, texte, horodatageISO: new Date().toISOString() });
  if (c.historique.length > 30) c.historique = c.historique.slice(-30); // borne la taille en memoire
}

function demarrerPauseHumain(conversationsHumain, telephone, messageClient) {
  const c = conversationsHumain[telephone] || { historique: [] };
  c.enAttente = true;
  c.depuisISO = new Date().toISOString();
  conversationsHumain[telephone] = c;
  ajouterMessageHistorique(conversationsHumain, telephone, "client", messageClient);
  return c;
}

// Appele quand le MARCHAND repond manuellement depuis /admin : remet le chrono de 10 minutes a zero.
// Retourne false si aucune conversation en pause n'existe pour ce numero (rien a faire cote appelant).
function repondreHumain(conversationsHumain, telephone, texteMarchand) {
  const c = conversationsHumain[telephone];
  if (!c) return false;
  c.enAttente = true;
  c.depuisISO = new Date().toISOString();
  ajouterMessageHistorique(conversationsHumain, telephone, "marchand", texteMarchand);
  return true;
}

function listerConversationsEnAttente(conversationsHumain) {
  return Object.keys(conversationsHumain)
    .filter((tel) => conversationsHumain[tel].enAttente)
    .map((tel) => Object.assign({ telephone: tel }, conversationsHumain[tel]))
    .sort((a, b) => new Date(a.depuisISO) - new Date(b.depuisISO));
}

module.exports = {
  formatFcfa,
  piocheParmi,
  parseAffirmative,
  parseNegative,
  parseWantsSomethingElse,
  echapperHtml,
  langueSession,
  t,
  detecterChangementLangue,
  detecterChoixLangueInitial,
  messageChoixLangue,
  demandeUnHumain,
  demandeVoirPanier,
  detecterIntentionRdv,
  messageMiseEnRelation,
  estMessageMiseEnRelation,
  estMessageChoixLangue,
  mentionHumainDisponible,
  pauseHumainActive,
  ajouterMessageHistorique,
  demarrerPauseHumain,
  repondreHumain,
  listerConversationsEnAttente
};
