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

const MOTS_CLES_HUMAIN = [
  "parler a un humain", "parler a quelqu'un", "parler a une personne", "vraie personne",
  "personne reelle", "un humain", "une humaine", "un vendeur", "une vendeuse", "un conseiller",
  "une conseillere", "un representant", "une representante", "un agent", "un responsable",
  "le gerant", "la gerante", "le patron", "la patronne", "quelqu'un d'autre", "assistance humaine",
  "parler a un vrai", "un etre humain"
];

// Reconnait qu'un client demande a parler a un humain, quel que soit le moment de la conversation.
function demandeUnHumain(texte) {
  const t = normaliserPourRecherche(texte);
  return MOTS_CLES_HUMAIN.some((mot) => t.includes(normaliserPourRecherche(mot)));
}

// Le message envoye au client UNE SEULE fois, au moment ou la pause commence.
const MESSAGE_MISE_EN_RELATION =
  "Je vous mets en relation avec un membre de notre équipe, merci de patienter quelques instants 🙏";

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
  demandeUnHumain,
  MESSAGE_MISE_EN_RELATION,
  pauseHumainActive,
  ajouterMessageHistorique,
  demarrerPauseHumain,
  repondreHumain,
  listerConversationsEnAttente
};
