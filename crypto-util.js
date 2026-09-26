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

module.exports = { chiffrer, dechiffrer, indiceAffichable };
