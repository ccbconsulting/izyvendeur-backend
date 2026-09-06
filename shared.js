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

module.exports = { formatFcfa, piocheParmi, parseAffirmative, parseNegative, parseWantsSomethingElse, echapperHtml };
