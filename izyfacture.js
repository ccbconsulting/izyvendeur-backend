// IzyVendeur - Pont vers IzyFacture (facturation automatique des commandes confirmees).
//
// Reference : API-IZYVENDEUR.md, document fourni par la conversation IzyFacture le 25 septembre 2026 (API
// v1 reelle, deja en service). Ce module respecte ses regles pratiques (section 9) :
//   - Delai d'attente de 15 secondes par appel (AbortController), pour ne jamais bloquer IzyVendeur.
//   - Une erreur HTTP 5xx, 429, ou reseau/delai dépasse est marquee `retryable=true` (a reessayer plus
//     tard) ; toute autre erreur 4xx est `retryable=false` (donnee incorrecte, reessayer a l'identique ne
//     changerait rien - voir le tableau de codes d'erreur de la doc, section 8).
//   - Anti-doublon via `source` + `externalRef` : reenvoyer la MEME commande ne cree jamais de facture en
//     double, meme apres plusieurs essais suite a des echecs reseau - voir externalRefPourCommande().
//
// Aucune dependance externe : `fetch`/`AbortController` sont natifs depuis Node 18 (ce projet tourne sur
// Node 22 en production comme en developpement - voir README-BILINGUE.md).

const BASE_URL = process.env.IZYFACTURE_API_URL || "https://izyfacture.ccbconsulting.org/api/v1";
const DELAI_MS = 15000;

// Appel HTTP de base. `apiKey` est la cle EN CLAIR (dechiffree par l'appelant juste avant l'appel, jamais
// conservee ni journalisee ici).
async function izf(method, chemin, apiKey, corps) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), DELAI_MS);
  try {
    const reponse = await fetch(BASE_URL + chemin, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: corps !== undefined ? JSON.stringify(corps) : undefined,
      signal: ctrl.signal
    });
    const donnees = await reponse.json().catch(() => ({}));
    if (!reponse.ok) {
      const erreur = new Error(donnees.error || ("IzyFacture HTTP " + reponse.status));
      erreur.status = reponse.status;
      erreur.code = donnees.code || null;
      erreur.retryable = reponse.status >= 500 || reponse.status === 429;
      throw erreur;
    }
    return donnees;
  } catch (erreur) {
    if (erreur.status === undefined) {
      // Aucun code HTTP recu : delai depasse (AbortError) ou echec reseau - toujours reessayable, comme
      // conseille par la doc (section 9, regle 2).
      erreur.retryable = true;
    }
    throw erreur;
  } finally {
    clearTimeout(minuteur);
  }
}

// Reference anti-doublon envoyee comme `externalRef` : identifie une commande IzyVendeur de facon unique et
// stable pour IzyFacture, meme entre deux marchands differents (chacun avec sa propre cle API de toute
// facon, mais une prefixation par marchand reste plus sure et plus lisible cote IzyFacture).
function externalRefPourCommande(merchantKey, orderId) {
  return merchantKey + "-CMD-" + orderId;
}

// `client.name` est obligatoire si le client est nouveau chez IzyFacture (voir doc section 3) - IzyVendeur
// ne connait pas le nom du client (seulement son telephone WhatsApp et son adresse), donc on construit un
// nom d'affichage a partir du numero, mieux que rien pour retrouver la facture plus tard.
function nomClientPourCommande(commande) {
  return commande.telephone ? "Client WhatsApp " + commande.telephone : "Client IzyVendeur";
}

function construireLignesPourCommande(commande) {
  return (commande.items || []).map((it) => {
    let desc = it.produit || "Article";
    const variante = [it.couleur, it.taille].filter(Boolean).join(" ");
    if (variante) desc += " (" + variante + ")";
    return { desc, qty: it.quantite || 1, price: it.prixUnitaire || 0 };
  });
}

// Verifie une cle (bouton "Tester la connexion" cote /admin) - GET /me, voir doc section 2.
async function verifierCle(apiKey) {
  return izf("GET", "/me", apiKey);
}

// Cree (ou retrouve, si deja envoyee) la facture d'une commande confirmee - POST /invoices, voir doc
// section 3. Aucun `payment` envoye : IzyVendeur ne sait pas si/combien le client a deja paye a ce stade
// (voir commentaire dans server.js) - le marchand enregistre lui-meme un paiement plus tard depuis
// IzyFacture s'il y a lieu.
async function facturerCommande(apiKey, merchantKey, commande) {
  const corps = {
    source: "izyvendeur",
    externalRef: externalRefPourCommande(merchantKey, commande.id),
    pricesIncludeTax: true,
    client: {
      name: nomClientPourCommande(commande),
      phone: commande.telephone || undefined,
      externalId: commande.telephone ? String(commande.telephone).replace(/\D/g, "") : undefined
    },
    lines: construireLignesPourCommande(commande),
    notes: "Commande WhatsApp " + externalRefPourCommande(merchantKey, commande.id)
  };
  return izf("POST", "/invoices", apiKey, corps);
}

// Paiement recu apres coup (ex: espèces a la livraison) - POST /invoices/{id}/payments, voir doc section 5.
// Pas encore relie a une action de /admin dans cette livraison (prevu pour une prochaine etape) - expose ici
// pour que la brique soit prete.
async function enregistrerPaiement(apiKey, invoiceId, paiement) {
  return izf("POST", "/invoices/" + invoiceId + "/payments", apiKey, paiement);
}

// Facture d'avoir (commande annulee ou retour) - POST /invoices/{id}/credit-notes, voir doc section 6. Une
// facture validee ne se supprime jamais (regle legale) : une annulation dans IzyVendeur, si la commande
// avait deja une facture, se traduit par un avoir total plutot que par une suppression.
async function creerAvoirAnnulation(apiKey, invoiceId, raison) {
  return izf("POST", "/invoices/" + invoiceId + "/credit-notes", apiKey, { reason: raison || "Commande annulée" });
}

module.exports = {
  izf,
  externalRefPourCommande,
  verifierCle,
  facturerCommande,
  enregistrerPaiement,
  creerAvoirAnnulation
};
