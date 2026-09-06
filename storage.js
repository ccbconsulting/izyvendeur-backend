// IzyVendeur - Hebergement des photos d'articles (Cloudflare R2)
//
// Pourquoi R2 plutot que S3 ou un autre service : R2 offre un niveau gratuit genereux (10 Go de
// stockage, ET surtout AUCUN frais de sortie/bande passante - contrairement a S3 qui facture chaque
// telechargement), ce qui convient bien a un usage TPE/PME ou les photos sont vues des centaines de
// fois par les clients via WhatsApp. R2 est compatible avec l'API S3 : on reutilise donc le SDK AWS
// officiel (@aws-sdk/client-s3) pointe vers l'endpoint de Cloudflare, sans dependre d'un SDK proprietaire.
//
// Configuration requise (variables d'environnement Render) : voir .env.example et le README, section
// "Photos des articles". Si ces variables sont absentes, ce module reste inerte (estConfigure() renvoie
// false) et les routes d'upload repondent une erreur claire plutot que de planter.

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET;
// URL publique de base du bucket (le domaine "Public Development URL" fourni par Cloudflare, ou un nom
// de domaine personnalise si vous en avez branche un) - SANS slash final, ex:
// "https://pub-xxxxxxxx.r2.dev" ou "https://photos.mondomaine.com".
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const EXTENSIONS_AUTORISEES = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };
const TAILLE_MAX_OCTETS = 5 * 1024 * 1024; // 5 Mo - alignee sur la limite WhatsApp elle-meme

let client = null;
function getClient() {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    });
  }
  return client;
}

function estConfigure() {
  return Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET && PUBLIC_BASE_URL);
}

// Upload une photo d'article et renvoie son URL publique. `merchantKey`/`productId` servent uniquement a
// ranger les fichiers de facon lisible dans le bucket (un dossier par marchand) - aucune donnee sensible
// n'y transite, ce ne sont que des identifiants techniques deja publics dans l'URL de l'API.
async function uploaderPhotoProduit({ merchantKey, productId, buffer, mimeType }) {
  if (!estConfigure()) {
    throw new Error("Hébergement des photos non configuré (variables R2_* manquantes sur le serveur).");
  }
  const extension = EXTENSIONS_AUTORISEES[mimeType];
  if (!extension) {
    throw new Error("Format d'image non pris en charge (JPEG, PNG ou WEBP uniquement).");
  }
  if (buffer.length > TAILLE_MAX_OCTETS) {
    throw new Error("Image trop volumineuse (5 Mo maximum).");
  }

  const cle = `marchands/${merchantKey}/${productId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: cle,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: "public, max-age=31536000, immutable",
  }));

  return `${PUBLIC_BASE_URL}/${cle}`;
}

// Supprime une photo du bucket a partir de son URL publique (best-effort : une erreur ici ne doit jamais
// empecher de retirer la reference cote catalogue, le fichier orphelin n'est pas grave en soi).
async function supprimerPhotoProduit(url) {
  if (!estConfigure() || !url || !url.startsWith(PUBLIC_BASE_URL + "/")) return;
  const cle = url.slice(PUBLIC_BASE_URL.length + 1);
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: cle }));
  } catch (erreur) {
    console.error("Echec de la suppression de la photo sur R2 (fichier orphelin laissé en place) :", erreur.message || erreur);
  }
}

module.exports = { estConfigure, uploaderPhotoProduit, supprimerPhotoProduit, EXTENSIONS_AUTORISEES, TAILLE_MAX_OCTETS };
