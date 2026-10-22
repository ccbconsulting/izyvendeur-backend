// IzyVendeur - Etape 77 : photos des SERVICES (volet rendez-vous) et des CHAMBRES (volet hebergement).
// Regles communes aux deux moteurs : 3 photos au maximum par element, jamais modifiees par le corps d'un PUT
// de la liste (seules les routes d'envoi / de suppression dediees y touchent), envoi au client au moment ou il
// CHOISIT l'element (comme pour les articles du catalogue), une seule fois par conversation et par element
// (re-envoi possible apres REEMISSION_MS : un client qui revient plus tard revoit la photo).
const MAX_PHOTOS = 3;
const REEMISSION_MS = 6 * 3600 * 1000;
const MAX_PHOTOS_PAR_MESSAGE = 6; // plafond si le client choisit plusieurs elements d'un coup

function nettoyer(photos) {
  return (Array.isArray(photos) ? photos : []).filter((u) => typeof u === "string" && u.trim() !== "").slice(0, MAX_PHOTOS);
}

// Ajoute une URL a un element (service ou chambre). Renvoie "ok", "plein" (deja 3) ou "doublon".
function ajouter(element, url) {
  if (!element || !url) return "invalide";
  const actuelles = nettoyer(element.photos);
  if (actuelles.indexOf(url) !== -1) return "doublon";
  if (actuelles.length >= MAX_PHOTOS) return "plein";
  element.photos = actuelles.concat([url]);
  return "ok";
}

function retirer(element, url) {
  if (!element) return false;
  const avant = nettoyer(element.photos);
  const apres = avant.filter((u) => u !== url);
  element.photos = apres;
  return apres.length !== avant.length;
}

// Reprend, pour chaque element de `nouvelleListe` portant un id deja connu, les photos de l'ancienne liste :
// le corps d'un PUT ne peut ni ajouter, ni retirer, ni contourner la limite de 3 photos (ni la regle qui
// reserve la suppression au proprietaire). Un element inconnu repart sans photo.
function conserverPhotos(ancienneListe, nouvelleListe) {
  const parId = {};
  (ancienneListe || []).forEach((e) => { if (e && e.id != null) parId[e.id] = nettoyer(e.photos); });
  nouvelleListe.forEach((e) => { if (!e) return; const garde = parId[e.id] || []; if (garde.length) e.photos = garde.slice(); else delete e.photos; });
  return nouvelleListe;
}

// URLs des photos orphelines (elements supprimes de la liste) : pour un menage best-effort sur R2.
function photosOrphelines(ancienneListe, nouvelleListe) {
  const restants = {};
  (nouvelleListe || []).forEach((e) => { if (e && e.id != null) restants[e.id] = true; });
  const out = [];
  (ancienneListe || []).forEach((e) => { if (e && !restants[e.id]) nettoyer(e.photos).forEach((u) => out.push(u)); });
  return out;
}

// Photos a envoyer pour les ids NOUVELLEMENT choisis par le client. `trouver(id)` renvoie l'element, `legende(element)`
// son texte. `memoire` = { id: horodatage } propre a ce client (gardee en memoire par le moteur, elle survit aux
// remises a zero de la session) : evite de renvoyer la meme photo en boucle.
// Etape 80 : `maxParElement` (1 ou 3) = nombre de photos envoyees AUTOMATIQUEMENT par element ; reglage du seul super-administrateur
// (chaque photo est un message WhatsApp facture). Absent = 3, comme avant.
function aEnvoyer(memoire, idsAvant, idsApres, trouver, legende, maintenant, maxParElement) {
  const maxEl = Number.isInteger(maxParElement) && maxParElement >= 1 ? Math.min(maxParElement, MAX_PHOTOS) : MAX_PHOTOS;
  const out = [];
  if (!memoire) return out;
  const t0 = maintenant || Date.now();
  const nouveaux = (idsApres || []).filter((id) => (idsAvant || []).indexOf(id) === -1);
  if (!nouveaux.length) return out;
  for (const id of nouveaux) {
    const dernier = memoire[id];
    if (dernier && t0 - dernier < REEMISSION_MS) continue;
    const element = trouver(id);
    if (!element) continue;
    const photos = nettoyer(element.photos).slice(0, maxEl);
    if (!photos.length) continue;
    const texte = legende(element);
    photos.forEach((url, i) => { if (out.length < MAX_PHOTOS_PAR_MESSAGE) out.push({ url, legende: i === 0 ? texte : null }); });
    memoire[id] = t0;
  }
  return out;
}

module.exports = { MAX_PHOTOS, REEMISSION_MS, nettoyer, ajouter, retirer, conserverPhotos, photosOrphelines, aEnvoyer };
