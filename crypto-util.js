// IzyVendeur - Chiffrement au repos de la cle API IzyFacture (voir izyfacture.js, decision du 25 septembre
// 2026 : la cle d'un marchand, une fois enregistree, doit etre chiffree en base plutot que stockee en clair).
//
// Algorithme : AES-256-GCM (authentifie - toute alteration du texte chiffre est detectee au dechiffrement).
// La cle de chiffrement vient de la variable d'environnement ENCRYPTION_KEY (Render : a definir une fois,
// n'importe quelle chaine suffisamment longue/aleatoire - elle est hachee en SHA-256 ci-dessous pour
// toujours obtenir exactement 32 octets, quelle que soit sa longueur d'origine).
//
// Repli DELIBERE si ENCRYPTION_KEY est absente (ex: developpement local sans .env complet) : on stocke la
// valeur EN CLAIR plutot que d'echouer ou de simuler un chiffrement inexistant, mais prefixee "clair:" pour
// que dechiffrer() la reconnaisse sans ambiguite et qu'on ne confonde jamais une valeur vraiment chiffree
// avec une valeur qui ne l'est pas. Un avertissement est ecrit dans les journaux a chaque chiffrement dans
// ce cas, pour qu'une absence de ENCRYPTION_KEY en production ne passe jamais inapercue.

const crypto = require("crypto");

const ALGORITHME = "aes-256-gcm";
const PREFIXE_CHIFFRE = "gcm:";
const PREFIXE_CLAIR = "clair:";

function cleDerivee() {
  const source = process.env.ENCRYPTION_KEY;
  if (!source) return null;
  // SHA-256 -> toujours 32 octets, quelle que soit la longueur/forme de ENCRYPTION_KEY fournie par
  // l'operateur (mot de passe, chaine hexadecimale, etc.) - AES-256 exige exactement 32 octets de cle.
  return crypto.createHash("sha256").update(source, "utf8").digest();
}

// Chiffre un texte pour le stockage. Retourne null pour une entree vide/absente (permet d'effacer une cle
// enregistree en repassant par la meme fonction de sauvegarde sans cas particulier).
function chiffrer(texteClair) {
  if (texteClair === null || texteClair === undefined || texteClair === "") return null;
  const cle = cleDerivee();
  if (!cle) {
    console.warn(
      "[crypto-util] ENCRYPTION_KEY non definie : une cle IzyFacture va etre stockee EN CLAIR. " +
      "A corriger avant la mise en production (definir ENCRYPTION_KEY sur Render)."
    );
    return PREFIXE_CLAIR + texteClair;
  }
  const iv = crypto.randomBytes(12); // 96 bits, taille recommandee pour GCM
  const chiffreur = crypto.createCipheriv(ALGORITHME, cle, iv);
  const chiffre = Buffer.concat([chiffreur.update(String(texteClair), "utf8"), chiffreur.final()]);
  const tag = chiffreur.getAuthTag(); // 16 octets - verifie l'integrite au dechiffrement
  return PREFIXE_CHIFFRE + Buffer.concat([iv, tag, chiffre]).toString("base64");
}

// Dechiffre une valeur produite par chiffrer(). Retourne null si la valeur est absente, dans un format
// inconnu, ou si le dechiffrement echoue (cle changee, donnees corrompues, ENCRYPTION_KEY manquante pour une
// valeur qui a ete chiffree avec une cle definie) - jamais d'exception qui remonterait jusqu'au client.
function dechiffrer(valeurStockee) {
  if (!valeurStockee) return null;
  if (valeurStockee.indexOf(PREFIXE_CLAIR) === 0) return valeurStockee.slice(PREFIXE_CLAIR.length);
  if (valeurStockee.indexOf(PREFIXE_CHIFFRE) !== 0) {
    console.error("[crypto-util] Format de valeur chiffree inconnu, impossible de dechiffrer.");
    return null;
  }
  const cle = cleDerivee();
  if (!cle) {
    console.error("[crypto-util] ENCRYPTION_KEY manquante : impossible de dechiffrer une cle IzyFacture deja chiffree.");
    return null;
  }
  try {
    const donnees = Buffer.from(valeurStockee.slice(PREFIXE_CHIFFRE.length), "base64");
    const iv = donnees.subarray(0, 12);
    const tag = donnees.subarray(12, 28);
    const chiffre = donnees.subarray(28);
    const dechiffreur = crypto.createDecipheriv(ALGORITHME, cle, iv);
    dechiffreur.setAuthTag(tag);
    return Buffer.concat([dechiffreur.update(chiffre), dechiffreur.final()]).toString("utf8");
  } catch (erreur) {
    console.error("[crypto-util] Echec du dechiffrement (cle changee ou donnees corrompues) :", erreur.message);
    return null;
  }
}

// Derniers caracteres d'une cle API, pour affichage sans jamais exposer la valeur complete cote /admin
// (ex: "izf_i1osAyLt...ab12" -> on ne montre que ce qui permet au marchand de reconnaitre SA cle).
function indiceAffichable(texteClair) {
  if (!texteClair || texteClair.length < 4) return "";
  return texteClair.slice(-4);
}

// ---------------- Jeton de session /admin (29 septembre 2026) ----------------
//
// Remplace l'authentification HTTP Basic (popup native du navigateur, sans notion de "session" ni de
// deconnexion fiable - voir server.js/protegerAcces) par un vrai ecran de connexion + un jeton de session
// SIGNE (jamais chiffre : le jeton ne contient aucune donnee secrete, seulement role/identifiant/expiration
// - il doit juste etre infalsifiable, pas confidentiel). Format : "<payload_base64url>.<signature_base64url>",
// signature HMAC-SHA256. Aucune session n'est stockee cote serveur (rien a nettoyer, rien qui ne survit pas
// a un redemarrage autrement que via le secret lui-meme) : toute l'information necessaire est dans le jeton,
// et protegerAcces revalide a CHAQUE requete que le compte designe existe toujours (voir server.js) - un
// jeton encore valide ne suffit donc jamais a lui seul si le compte a ete supprime/suspendu entre-temps.
const SESSION_ALGORITHME = "sha256";

// Secret de signature : SESSION_SECRET (Render, a definir une fois pour que les sessions survivent aux
// redemarrages du serveur) - repli DELIBERE sur un secret aleatoire genere une seule fois au demarrage du
// processus si absent (developpement local), avec avertissement explicite (meme principe que ENCRYPTION_KEY
// ci-dessus) : sans ca, tout le monde serait deconnecte a chaque redemarrage en production, ce qui doit se
// remarquer immediatement dans les journaux plutot que de surprendre silencieusement plus tard.
let secretSessionEphemere = null;
function secretSession() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!secretSessionEphemere) {
    secretSessionEphemere = crypto.randomBytes(32).toString("hex");
    console.warn(
      "[crypto-util] SESSION_SECRET non definie : un secret temporaire a ete genere au demarrage. " +
      "Tout le monde sera deconnecte au prochain redemarrage du serveur. Definissez SESSION_SECRET sur " +
      "Render (une chaine aleatoire suffisamment longue) pour des sessions qui survivent aux redemarrages."
    );
  }
  return secretSessionEphemere;
}

function base64urlEncode(texte) {
  return Buffer.from(texte, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(texte) {
  const normalise = texte.replace(/-/g, "+").replace(/_/g, "/");
  const complete = normalise + "=".repeat((4 - (normalise.length % 4)) % 4);
  return Buffer.from(complete, "base64").toString("utf8");
}
function signerBase64url(texte) {
  return crypto.createHmac(SESSION_ALGORITHME, secretSession()).update(texte).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// `payload` : objet simple (role/merchantId/employeId/adminUser...), jamais de donnee sensible (mot de
// passe, cle...). `dureeMs` : duree de validite ABSOLUE depuis maintenant (server.js la reemet a chaque
// requete authentifiee pour obtenir une session "glissante" - voir protegerAcces).
function genererJetonSession(payload, dureeMs) {
  const corps = base64urlEncode(JSON.stringify(Object.assign({}, payload, { exp: Date.now() + dureeMs })));
  return corps + "." + signerBase64url(corps);
}

// Verifie la signature (comparaison a temps constant - evite qu'une attaque par mesure de temps de reponse
// puisse deviner la signature attendue octet par octet) ET l'expiration. Renvoie le payload si valide, sinon
// null (jeton absent, malforme, signature invalide, ou expire) - jamais d'exception.
function verifierJetonSession(jeton) {
  if (!jeton || typeof jeton !== "string") return null;
  const separateur = jeton.lastIndexOf(".");
  if (separateur === -1) return null;
  const corps = jeton.slice(0, separateur);
  const signatureRecue = jeton.slice(separateur + 1);
  const signatureAttendue = signerBase64url(corps);
  const bufRecue = Buffer.from(signatureRecue);
  const bufAttendue = Buffer.from(signatureAttendue);
  if (bufRecue.length !== bufAttendue.length || !crypto.timingSafeEqual(bufRecue, bufAttendue)) return null;
  let payload;
  try { payload = JSON.parse(base64urlDecode(corps)); } catch (erreur) { return null; }
  if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  return payload;
}

module.exports = { chiffrer, dechiffrer, indiceAffichable, genererJetonSession, verifierJetonSession };
