// IzyVendeur - Moteur de conversation "catalogue" (vente de produits par variantes)
//
// Reproduit la logique du prototype "Simulateur WhatsApp" : reconnaissance de l'article/couleur/taille
// demandes dans le message du client, verification du stock virtuel (stock reel moins les commandes deja
// Confirmee/Expediee), panier multi-articles, demande des infos de livraison, recapitulatif, confirmation.
//
// Depuis le passage au multi-marchand : ce module exporte une FACTORY (createCatalogEngine(merchantKey))
// au lieu d'un singleton. Chaque marchand "catalogue" possede sa propre instance, avec son propre etat
// (catalogue + commandes + parametres) et ses propres sessions de conversation en cours - aucun risque de
// melanger les clients ou le stock de deux marchands differents, meme s'ils ecrivent au meme moment.

const { PROD_KEYWORDS, DEFAULT_AUTO_CONFIRM_MESSAGE, SEED_CATALOG } = require("./catalog");
const db = require("./db");
const sh = require("./shared");
const { formatFcfa, piocheParmi, parseAffirmative, parseNegative, parseWantsSomethingElse } = sh;

const RESERVING_STATUSES = ["Confirmée", "Expédiée"];
const STATUT_LIST = ["Nouvelle", "Confirmée", "Expédiée", "Livrée", "Annulée"];
const STOPWORDS = ["de", "du", "des", "la", "le", "les", "en", "à", "au", "aux", "et", "un", "une", "2", "3"];

// Garde-fou anti-inondation : au-dela de ce nombre de commandes "Nouvelle" (jamais confirmees) creees
// par le MEME numero WhatsApp reel dans cette fenetre de temps, on refuse d'en creer une de plus tant
// qu'une commande precedente n'a pas ete traitee. Fenetre courte pour ne viser que le spam rapide, pas
// un client fidele qui revient a plusieurs reprises sur plusieurs jours/semaines.
const MAX_PENDING_ORDERS_PER_PHONE = 3;
const PENDING_ORDERS_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 heures

const OUVERTURES_PRODUIT = ["Excellent choix !", "Très bon choix !", "Superbe choix !", "Vous avez bon goût !", "Beau choix !"];
const OUVERTURES_COULEUR = ["Jolie couleur !", "Bon choix de couleur !", "Ça va très bien !", "Très élégant !"];
const OUVERTURES_DISPO = ["Parfait,", "Très bien,", "Super,", "Excellente nouvelle,"];
const OUVERTURES_AJOUT = ["Très bien !", "Parfait !", "Excellent !", "Noté !", "Top !"];
const OUVERTURES_RECAP = ["Très bien !", "Parfait, on y est presque !", "Super !"];

function seedState() {
  return {
    catalog: JSON.parse(JSON.stringify(SEED_CATALOG)),
    orders: [],
    nextId: 1,
    settings: { autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE },
    inventorySnapshots: [] // instantanés d'inventaire enregistrés depuis l'onglet Rapports (voir plus bas)
  };
}

// Numero de telephone reserve, utilise UNIQUEMENT par le Simulateur WhatsApp de /admin (jamais un vrai
// client). Les commandes creees sous ce numero sont marquees source:"simulateur" et exclues partout
// ailleurs (stock virtuel reel, listes/rapports de commandes) pour qu'un test depuis /admin ne puisse
// JAMAIS affecter ce que voient les vrais clients ni polluer les vraies statistiques du marchand.
const PHONE_SIMULATEUR = "SIMULATEUR";

// `options.envoyer(destinataire, texte)` envoie un message WhatsApp a N'IMPORTE QUEL numero (utilise pour
// les reponses manuelles du marchand a un client mis en pause) ; `options.notifierMarchand(typeAlerte,
// params)` envoie une alerte au numero de notification personnel du marchand (no-op si non configure) —
// `typeAlerte` choisit le template ("humain", "commande_confirmee", ...) et `params` est la liste de
// valeurs BRUTES (pas de texte deja mis en forme) a inserer dans ses variables, dans l'ordre attendu par
// ce template. C'est server.js qui choisit, a cet endroit, d'envoyer un template WhatsApp approuve ou un
// texte libre de repli. Les deux fonctions sont fournies par server.js, qui seul connait le token
// WhatsApp et le phone_number_id de ce marchand.
function createCatalogEngine(merchantKey, options) {
  let state = null;
  const sessions = {};
  const conversationsHumain = {}; // memoire seulement (comme `sessions`) - voir shared.js
  const envoyer = (options && options.envoyer) || (async () => {});
  const notifierMarchand = (options && options.notifierMarchand) || (async () => {});
  // `options.envoyerImage(destinataire, url, legende)` envoie une photo d'article via WhatsApp (voir
  // storage.js pour l'hebergement, server.js pour l'appel a l'API Graph). No-op si non fourni (compatible
  // avec d'anciens appels/tests qui ne passent pas cette option).
  const envoyerImage = (options && options.envoyerImage) || (async () => {});
  // `options.journaliser(telephone, de, texte)` enregistre durablement un message dans le journal complet
  // des conversations (voir db.js) - pour l'onglet "Historique" de /admin. Toujours appele en
  // fire-and-forget (jamais attendu, jamais laisse faire planter la conversation en cas d'echec).
  const journaliserOption = (options && options.journaliser) || (async () => {});
  function journaliser(telephone, de, texte) {
    if (!telephone || telephone === PHONE_SIMULATEUR) return; // jamais le Simulateur dans le vrai journal
    journaliserOption(telephone, de, texte).catch((erreur) =>
      console.error("[" + merchantKey + "] Echec de journalisation de la conversation :", erreur)
    );
  }
  // Glisse la mention "un conseiller reste disponible" UNE SEULE fois par client, a sa toute premiere
  // reponse - memoire seulement (comme `sessions`/`conversationsHumain`) : un redemarrage remet a zero,
  // ce qui n'est pas grave (au pire un client tres occasionnel la revoit un jour).
  const humanHintDonne = {};

  // A appeler une seule fois, au demarrage du serveur, AVANT de traiter le moindre message pour ce marchand.
  async function init() {
    state = await db.initMerchantState(merchantKey, seedState);
    if (!state.settings) state.settings = { autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE };
    if (!state.inventorySnapshots) state.inventorySnapshots = [];
  }

  function saveState() {
    if (!state) return;
    db.persistMerchantState(merchantKey, state).catch((erreur) => {
      console.error("[" + merchantKey + "] Erreur de sauvegarde de l'etat (la derniere modification pourrait etre perdue au redemarrage) :", erreur);
    });
  }

  function freshSession() {
    return {
      stage: "idle",
      cart: [],
      productId: null,
      couleur: null,
      taille: null,
      quantite: null,
      telephone: null,
      adresse: null,
      pendingOrderId: null,
      // "livraison" ou "retrait" une fois que le client a choisi (uniquement si le marchand a configure
      // une adresse de retrait en boutique, voir retraitConfigure() plus bas - sinon la question n'est
      // jamais posee et modeLivraison reste "livraison" par defaut sur la commande, comme avant).
      modeLivraison: null,
      // true UNIQUEMENT quand la reponse de CE tour est un "quel article vous interesse ?" (les autres
      // moments ou stage vaut aussi "idle" - ex: en plein choix de couleur/taille, ou juste apres un
      // "merci pour votre commande" - ne doivent PAS re-proposer la liste des articles). Voir
      // getEtatSession(), utilise par server.js pour decider d'envoyer une liste WhatsApp cliquable.
      pretPourChoix: false,
      // Non-null UNIQUEMENT quand la reponse de CE tour demande de choisir une couleur, une taille, ou
      // une variante alternative (rupture de stock) - meme principe que pretPourChoix ci-dessus, pour que
      // server.js puisse proposer une liste cliquable de couleurs/tailles en plus du texte libre existant.
      // Forme : { type: "couleur"|"taille"|"variante", options: [...] } (voir processMessage plus bas).
      pendingChoice: null
    };
  }

  function getSession(fromPhone) {
    if (!sessions[fromPhone]) sessions[fromPhone] = freshSession();
    sessions[fromPhone].fromPhone = fromPhone;
    return sessions[fromPhone];
  }

  function parseQuantity(text) {
    const m = text.match(/\d+/);
    if (m) return parseInt(m[0], 10);
    const words = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
    const t = text.toLowerCase();
    for (const w in words) {
      if (new RegExp("\\b" + w + "\\b", "i").test(t)) return words[w];
    }
    return null;
  }

  function itemsTotal(items) {
    return items.reduce((s, it) => s + it.prixUnitaire * it.quantite, 0);
  }

  function describeItems(items) {
    return items
      .map((it) => "• " + it.produit + " — " + it.couleur + " · " + it.taille + " × " + it.quantite + " — " + formatFcfa(it.prixUnitaire * it.quantite))
      .join("\n");
  }

  function orderRef(o) {
    return "CMD-" + String(o.id).padStart(4, "0");
  }

  function messageRecapPanier(cart) {
    return piocheParmi(OUVERTURES_RECAP) + " Voici votre panier :\n" + describeItems(cart) + "\nTotal : " + formatFcfa(itemsTotal(cart)) + "\n\nPour finaliser, envoyez-moi votre numéro et votre adresse de livraison.";
  }

  // true si le marchand a renseigne une adresse de retrait en boutique (Paramètres > Retrait en boutique -
  // state.settings.retrait) - optionnel : tant que ce n'est pas rempli, le client n'a jamais la question
  // et tout se passe exactement comme avant (adresse de livraison demandee directement).
  function retraitConfigure() {
    return !!(state.settings.retrait && state.settings.retrait.adresse && String(state.settings.retrait.adresse).trim());
  }

  function infosRetrait() {
    const r = state.settings.retrait || {};
    const adresse = String(r.adresse || "").trim();
    const horaires = String(r.horaires || "").trim();
    return adresse + (horaires ? " (" + horaires + ")" : "");
  }

  // Meme recapitulatif que messageRecapPanier(), mais enchaine sur la question livraison/retrait au lieu
  // de demander directement l'adresse - utilise uniquement quand retraitConfigure() est vrai (voir les 2
  // points d'appel dans processMessage, sur l'abandon du panier).
  function messageChoixModeLivraison(cart) {
    return piocheParmi(OUVERTURES_RECAP) + " Voici votre panier :\n" + describeItems(cart) + "\nTotal : " + formatFcfa(itemsTotal(cart)) + "\n\nSouhaitez-vous une livraison à domicile, ou un retrait en boutique ?";
  }

  // Point commun aux 3 endroits ou le panier vient d'etre finalise (panier confirme, selection abandonnee
  // avec un panier non vide) : bascule vers la question livraison/retrait si le marchand l'a configuree,
  // sinon directement vers la demande d'adresse de livraison comme avant. Modifie `session` et renvoie le
  // texte a repondre.
  function finaliserPanier(session) {
    if (retraitConfigure()) {
      session.stage = "awaiting_mode_livraison";
      session.pendingChoice = { type: "mode_livraison", options: ["Livraison", "Retrait en boutique"] };
      return messageChoixModeLivraison(session.cart);
    }
    session.stage = "awaiting_delivery";
    return messageRecapPanier(session.cart);
  }

  function distinctValues(getter) {
    const seen = {};
    const out = [];
    state.catalog.forEach((p) => {
      p.variantes.forEach((v) => {
        const val = getter(p, v);
        if (val && !seen[val]) {
          seen[val] = 1;
          out.push(val);
        }
      });
    });
    return out;
  }

  function findVariant(productId, couleur, taille) {
    const p = state.catalog.filter((x) => x.id === productId)[0];
    if (!p) return null;
    return p.variantes.filter((v) => v.couleur === couleur && v.taille === taille)[0] || null;
  }

  function reservedQty(productId, couleur, taille) {
    let sum = 0;
    state.orders.forEach((o) => {
      if (o.source === "simulateur") return; // jamais d'impact du Simulateur sur le stock reel
      if (RESERVING_STATUSES.indexOf(o.statut) === -1) return;
      (o.items || []).forEach((it) => {
        if (it.productId === productId && it.couleur === couleur && it.taille === taille) sum += it.quantite || 1;
      });
    });
    return sum;
  }

  function virtualStock(productId, variant) {
    return Math.max(0, variant.stockReel - reservedQty(productId, variant.couleur, variant.taille));
  }

  function buildProductIndex() {
    return state.catalog.map((p) => {
      const extra = PROD_KEYWORDS[p.id] || [];
      const nameWords = p.nom
        .toLowerCase()
        .split(/[^a-zà-ÿ0-9]+/)
        .filter((w) => w.length >= 3 && STOPWORDS.indexOf(w) === -1);
      const keywords = [p.nom.toLowerCase()].concat(extra, nameWords).filter((v, i, a) => a.indexOf(v) === i);
      return { id: p.id, keywords };
    });
  }

  function matchProduct(text) {
    const t = text.toLowerCase();
    const candidates = [];
    buildProductIndex().forEach((entry) => {
      entry.keywords.forEach((kw) => {
        if (kw && t.indexOf(kw) !== -1) candidates.push({ id: entry.id, len: kw.length });
      });
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.len - a.len);
    return candidates[0].id;
  }

  function matchCouleur(text) {
    const t = text.toLowerCase();
    const colors = distinctValues((p, v) => v.couleur).sort((a, b) => b.length - a.length);
    for (let i = 0; i < colors.length; i++) {
      if (colors[i] && t.indexOf(colors[i].toLowerCase()) !== -1) return colors[i];
    }
    return null;
  }

  function matchTaille(text) {
    const t = " " + text.toLowerCase() + " ";
    const tailles = distinctValues((p, v) => v.taille).sort((a, b) => b.length - a.length);
    for (let i = 0; i < tailles.length; i++) {
      const tv = tailles[i];
      if (!tv) continue;
      const esc = tv.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("(^|[^a-zà-ÿ0-9])" + esc + "([^a-zà-ÿ0-9]|$)", "i");
      if (re.test(t)) return tv;
    }
    const m = t.match(/\b(xxl|xl|xs|s|m|l)\b/i);
    if (m) return m[1].toUpperCase();
    const mn = t.match(/\b(3[0-9]|4[0-9])\b/);
    if (mn) return mn[1];
    if (t.indexOf("unique") !== -1) return "Unique";
    return null;
  }

  function createOrderFromCart(sess) {
    const items = sess.cart.map((it) => ({
      productId: it.productId,
      produit: it.produit,
      couleur: it.couleur,
      taille: it.taille,
      quantite: it.quantite,
      prixUnitaire: it.prixUnitaire,
      prix: it.prixUnitaire * it.quantite
    }));
    const total = itemsTotal(items);
    const order = {
      id: state.nextId++,
      dateISO: new Date().toISOString(),
      items,
      prix: total,
      telephone: sess.telephone,
      adresse: sess.adresse,
      modeLivraison: sess.modeLivraison || "livraison",
      statut: "Nouvelle",
      raisonAnnulation: null,
      source: sess.fromPhone === PHONE_SIMULATEUR ? "simulateur" : "whatsapp",
      fromWhatsapp: sess.fromPhone || null
    };
    state.orders.push(order);
    saveState();
    return order;
  }

  function applyStatusChange(order, newStatus, raisonAnnulation) {
    const oldStatus = order.statut;
    if (oldStatus === newStatus) {
      if (newStatus === "Annulée" && raisonAnnulation) order.raisonAnnulation = raisonAnnulation;
      return;
    }
    (order.items || []).forEach((it) => {
      const variant = findVariant(it.productId, it.couleur, it.taille);
      if (!variant) return;
      const qty = it.quantite || 1;
      if (newStatus === "Livrée" && oldStatus !== "Livrée") variant.stockReel = Math.max(0, variant.stockReel - qty);
      if (oldStatus === "Livrée" && newStatus !== "Livrée") variant.stockReel += qty;
    });
    order.statut = newStatus;
    if (newStatus === "Annulée") order.raisonAnnulation = raisonAnnulation || order.raisonAnnulation || null;
    else order.raisonAnnulation = null;
    saveState();
  }

  function processMessage(session, text) {
    const trace = { message: text, entites: {}, verification: null, action: null, photo: null };
    // Reinitialise a chaque tour - seuls les 4 points de retour "quel article vous interesse ?" plus bas
    // le repassent a true juste avant de renvoyer leur texte (voir freshSession() ci-dessus).
    session.pretPourChoix = false;
    // Idem pour pendingChoice - reinitialise a chaque tour, repositionne uniquement aux 3 points de retour
    // "quelle couleur / quelle taille / rupture, laquelle de ces variantes" plus bas.
    session.pendingChoice = null;

    if (session.stage === "awaiting_quantity") {
      const otherProduct = matchProduct(text);
      if (otherProduct && otherProduct !== session.productId) {
        session.productId = null; session.couleur = null; session.taille = null; session.quantite = null;
        session.stage = "idle";
        trace.action = "Client change d'article pendant la demande de quantité — nouvelle sélection prise en compte";
        logTrace(session, trace);
        return processMessage(session, text);
      }
      const product0 = state.catalog.filter((p) => p.id === session.productId)[0];
      const variant0 = product0 ? product0.variantes.filter((v) => v.couleur === session.couleur && v.taille === session.taille)[0] : null;
      const virt0 = variant0 ? virtualStock(product0.id, variant0) : 0;
      const qty = parseQuantity(text);
      trace.entites = { "Quantité demandée": qty != null ? qty : "—", "Stock virtuel disponible": virt0 };
      if (qty == null || qty < 1) {
        if (parseNegative(text) || parseWantsSomethingElse(text)) {
          session.productId = null; session.couleur = null; session.taille = null; session.quantite = null;
          session.stage = "idle";
          trace.action = "Client abandonne cet article pendant la demande de quantité — sélection effacée";
          logTrace(session, trace);
          session.pretPourChoix = true;
          return "Pas de souci, on laisse cet article de côté. Quel article vous intéresse ? Nous avons : " + state.catalog.map((p) => p.nom).join(", ") + ".";
        }
        trace.action = "Quantité non comprise — nouvelle demande";
        logTrace(session, trace);
        return "Merci d'indiquer un nombre de pièces (ex : 1, 2, 3…).";
      }
      if (qty > virt0) {
        trace.action = "Quantité demandée supérieure au stock virtuel disponible";
        logTrace(session, trace);
        return "Il ne me reste que " + virt0 + " pièce(s) disponible(s) pour " + product0.nom + " " + variant0.couleur + " " + variant0.taille + ". Combien en voulez-vous (max " + virt0 + ") ?";
      }
      session.cart.push({ productId: product0.id, produit: product0.nom, couleur: variant0.couleur, taille: variant0.taille, quantite: qty, prixUnitaire: variant0.prix });
      session.productId = null; session.couleur = null; session.taille = null; session.quantite = null;
      session.stage = "awaiting_more_items";
      trace.action = "Article ajouté au panier — proposition d'ajouter un autre article";
      logTrace(session, trace);
      return piocheParmi(OUVERTURES_AJOUT) + " Ajouté au panier ✅ " + qty + " × " + product0.nom + " " + variant0.couleur + " " + variant0.taille + " — " + formatFcfa(variant0.prix * qty) + ".\nSouhaitez-vous ajouter un autre article à votre commande ? (oui / non)";
    }

    if (session.stage === "awaiting_more_items") {
      trace.entites = { "Réponse client": text };
      if (parseAffirmative(text)) {
        session.stage = "idle";
        trace.action = "Client souhaite ajouter un autre article au panier";
        logTrace(session, trace);
        session.pretPourChoix = true;
        return "Très bien, quel autre article souhaitez-vous ?";
      }
      const directProduct = !parseNegative(text) ? matchProduct(text) : null;
      if (directProduct) {
        session.stage = "idle";
        trace.action = "Client a nommé directement un nouvel article plutôt que de répondre oui/non — traitement immédiat";
        logTrace(session, trace);
        return processMessage(session, text);
      }
      trace.action = "Panier finalisé (" + session.cart.length + " article(s)) — " + (retraitConfigure() ? "choix livraison/retrait demandé" : "infos de livraison demandées");
      const reponseFinalisation = finaliserPanier(session);
      logTrace(session, trace);
      return reponseFinalisation;
    }

    if (session.stage === "awaiting_mode_livraison") {
      trace.entites = { "Réponse client": text };
      const t = text.toLowerCase();
      const veutRetrait = /retrait|boutique|magasin|chercher|passer\s+prendre|sur\s*place/.test(t);
      const veutLivraison = /livraison|domicile|livrer|envoie[rz]?[- ]moi|livre[sz]?[- ]moi/.test(t);

      if (veutRetrait && !veutLivraison) {
        session.modeLivraison = "retrait";
        session.adresse = "Retrait en boutique — " + infosRetrait();
        session.stage = "awaiting_delivery"; // reutilise la meme etape/logique de collecte (adresse deja pre-remplie, seul le telephone manque)
        trace.action = "Client choisit le retrait en boutique — adresse pré-remplie, téléphone encore demandé";
        logTrace(session, trace);
        return "Parfait, vous pourrez récupérer votre commande à " + infosRetrait() + ". Merci de m'indiquer votre numéro de téléphone pour vous joindre.";
      }
      if (veutLivraison && !veutRetrait) {
        session.modeLivraison = "livraison";
        session.stage = "awaiting_delivery";
        trace.action = "Client choisit la livraison à domicile — infos de livraison demandées";
        logTrace(session, trace);
        return "Très bien, merci de m'indiquer votre numéro de téléphone et votre adresse de livraison.";
      }
      trace.action = "Choix livraison/retrait ambigu — nouvelle demande de précision";
      logTrace(session, trace);
      session.pendingChoice = { type: "mode_livraison", options: ["Livraison", "Retrait en boutique"] };
      return "Je n'ai pas bien compris : souhaitez-vous une livraison à domicile, ou un retrait en boutique ?";
    }

    if (session.stage === "awaiting_delivery") {
      const phoneMatch = text.match(/(\+?237)?[\s.-]?[62]\d{7,8}/);
      const additiveIntent = /\b(aussi|encore|ajout|en\s*plus)\b/i.test(text);
      if (!phoneMatch && !session.adresse && (text.trim().length <= 20 || additiveIntent)) {
        const directProduct = matchProduct(text);
        if (directProduct) {
          session.stage = "idle";
          trace.entites = { "Réponse client": text };
          trace.action = "Client tente d'ajouter un article pendant la collecte des infos de livraison — traitement immédiat";
          logTrace(session, trace);
          return processMessage(session, text);
        }
      }
      let remaining = text;
      if (phoneMatch) { session.telephone = phoneMatch[0].trim(); remaining = text.replace(phoneMatch[0], "").trim(); }
      // En retrait, l'adresse est deja pre-remplie avec celle de la boutique (voir awaiting_mode_livraison
      // ci-dessus) - on ne la laisse JAMAIS ecraser par du texte que le client tape en donnant son numero
      // (ex: "677123456 merci" -> le reste ne doit pas remplacer l'adresse de retrait).
      if (session.modeLivraison !== "retrait" && remaining && remaining.replace(/[,\-\s]/g, "").length > 3) {
        session.adresse = remaining.replace(/^[,\-\s]+/, "").slice(0, 200);
      }
      trace.entites = { "Téléphone": session.telephone || "—", "Adresse": session.adresse || "—" };
      if (session.telephone && session.adresse) {
        const now = Date.now();
        const pendingCount = state.orders.filter((o) => {
          if (o.fromWhatsapp !== session.fromPhone || o.statut !== "Nouvelle") return false;
          const age = now - new Date(o.dateISO).getTime();
          return age >= 0 && age < PENDING_ORDERS_WINDOW_MS;
        }).length;
        if (pendingCount >= MAX_PENDING_ORDERS_PER_PHONE) {
          trace.action = "Trop de commandes non confirmées en attente pour ce numéro (" + pendingCount + ") — nouvelle commande refusée";
          logTrace(session, trace);
          return "Vous avez déjà " + pendingCount + " commande(s) en attente de confirmation. Merci de confirmer ou d'annuler l'une d'entre elles avant d'en passer une nouvelle — notre équipe reste disponible si besoin.";
        }
        const order = createOrderFromCart(session);
        session.pendingOrderId = order.id;
        session.stage = "awaiting_order_confirmation";
        trace.action = "Commande " + orderRef(order) + " créée (statut Nouvelle) — récapitulatif envoyé, confirmation demandée";
        logTrace(session, trace);
        const libelleAdresse = session.modeLivraison === "retrait" ? "Retrait" : "Livraison";
        return "Merci pour ces informations ! Voici le récapitulatif de votre commande (" + orderRef(order) + ") :\n" + describeItems(order.items) + "\nTotal : " + formatFcfa(order.prix) + "\n" + libelleAdresse + " : " + session.adresse + "\n\nConfirmez-vous cette commande ? (oui / non)";
      }
      const missing = [];
      if (!session.telephone) missing.push("numéro de téléphone");
      if (!session.adresse) missing.push("adresse de livraison");
      trace.action = "Information manquante demandée : " + missing.join(" et ");
      logTrace(session, trace);
      return "Presque ! Il me manque encore : " + missing.join(" et ") + ".";
    }

    if (session.stage === "awaiting_order_confirmation") {
      const pendingOrder = state.orders.filter((x) => x.id === session.pendingOrderId)[0];
      trace.entites = { "Réponse client": text };

      if (pendingOrder && parseAffirmative(text)) {
        applyStatusChange(pendingOrder, "Confirmée");
        trace.action = "Client confirme — commande " + orderRef(pendingOrder) + " passée automatiquement en Confirmée";
        notifierMarchand("commande_confirmee", [
          orderRef(pendingOrder),
          describeItems(pendingOrder.items),
          formatFcfa(pendingOrder.prix),
          pendingOrder.telephone || session.fromPhone || "—",
          pendingOrder.adresse || "—"
        ]).catch((erreur) =>
          console.error("[" + merchantKey + "] Echec de la notification marchand (commande confirmée) :", erreur)
        );
        const reply = (state.settings && state.settings.autoConfirmMessage) || DEFAULT_AUTO_CONFIRM_MESSAGE;
        Object.assign(session, freshSession());
        logTrace(session, trace);
        return reply;
      }

      if (pendingOrder && parseNegative(text)) {
        trace.action = "Client décline la confirmation automatique — commande " + orderRef(pendingOrder) + " reste en Nouvelle, à confirmer manuellement";
        const reply = "Très bien, votre commande reste enregistrée. Notre équipe reviendra vers vous pour la confirmer.";
        Object.assign(session, freshSession());
        logTrace(session, trace);
        return reply;
      }

      if (pendingOrder) {
        trace.action = "Réponse ambiguë — nouvelle demande de confirmation claire pour " + orderRef(pendingOrder);
        logTrace(session, trace);
        return "Je n'ai pas bien compris. Confirmez-vous votre commande " + orderRef(pendingOrder) + " ? Répondez simplement par oui ou non — notre équipe reviendra vers vous pour toute autre question.";
      }

      const reply = "Très bien, votre commande reste enregistrée.";
      Object.assign(session, freshSession());
      logTrace(session, trace);
      return reply;
    }

    const produitReconnu = matchProduct(text);
    const couleurReconnue = matchCouleur(text);
    const tailleReconnue = matchTaille(text);

    if (!produitReconnu && !couleurReconnue && !tailleReconnue && session.productId && (parseNegative(text) || parseWantsSomethingElse(text))) {
      session.productId = null; session.couleur = null; session.taille = null; session.quantite = null;
      trace.entites = { "Réponse client": text };
      if (session.cart.length > 0) {
        trace.action = "Client abandonne cette sélection en cours — panier finalisé (" + session.cart.length + " article(s))";
        const reponseFinalisation = finaliserPanier(session);
        logTrace(session, trace);
        return reponseFinalisation;
      }
      trace.action = "Client abandonne cette sélection en cours — sélection effacée";
      logTrace(session, trace);
      session.pretPourChoix = true;
      return "Pas de souci ! Quel article vous intéresse ? Nous avons : " + state.catalog.map((p) => p.nom).join(", ") + ".";
    }

    const produitIdPrecedent = session.productId;
    let produitId = produitReconnu || session.productId;
    const couleur = couleurReconnue || (produitId === session.productId ? session.couleur : null);
    let taille = tailleReconnue || (produitId === session.productId ? session.taille : null);
    session.productId = produitId; session.couleur = couleur; session.taille = taille;

    trace.entites = {
      "Produit": produitId ? state.catalog.filter((p) => p.id === produitId)[0].nom : "—",
      "Couleur": couleur || "—",
      "Taille": taille || "—"
    };

    if (!produitId && session.cart.length > 0 && parseNegative(text)) {
      trace.action = "Client ne veut rien ajouter de plus — panier finalisé (" + session.cart.length + " article(s))";
      const reponseFinalisation = finaliserPanier(session);
      logTrace(session, trace);
      return reponseFinalisation;
    }

    if (!produitId) {
      trace.action = "Précision demandée : quel article ?";
      logTrace(session, trace);
      session.pretPourChoix = true;
      return "Bonjour ! Quel article vous intéresse ? Nous avons : " + state.catalog.map((p) => p.nom).join(", ") + ".";
    }

    const product = state.catalog.filter((p) => p.id === produitId)[0];

    // Nouvel article identifie dans CE message (pas juste redit d'un tour a l'autre) : on envoie sa
    // premiere photo si le marchand en a enregistre au moins une (voir ajouterPhotoProduit ci-dessous /
    // onglet Catalogue de /admin). Ne se redeclenche pas tant que le client reste sur le meme article.
    if (produitReconnu && produitId !== produitIdPrecedent) {
      trace.photo = envoyerPhotoProduit(session.fromPhone, product);
    }

    const availableColors = product.variantes.map((v) => v.couleur).filter((v, i, a) => a.indexOf(v) === i);

    if (!couleur) {
      trace.action = "Précision demandée : quelle couleur ?";
      logTrace(session, trace);
      session.pendingChoice = { type: "couleur", options: availableColors };
      const ouverture = produitReconnu ? piocheParmi(OUVERTURES_PRODUIT) + " " : "";
      return ouverture + product.nom + " — quelle couleur souhaitez-vous ? Disponible en : " + availableColors.join(", ") + ".";
    }

    const sizesForColor = product.variantes.filter((v) => v.couleur === couleur).map((v) => v.taille);
    const uniqueSizes = sizesForColor.filter((v, i, a) => a.indexOf(v) === i);
    if (!taille && uniqueSizes.length === 1) {
      taille = uniqueSizes[0];
      session.taille = taille;
      trace.entites["Taille"] = taille + " (taille unique disponible)";
    }
    if (!taille) {
      trace.action = "Précision demandée : quelle taille ?";
      logTrace(session, trace);
      session.pendingChoice = { type: "taille", options: uniqueSizes };
      const ouverture = couleurReconnue ? piocheParmi(OUVERTURES_COULEUR) + " " : "";
      return ouverture + "Quelle taille pour " + product.nom + " " + couleur + " ? Disponible : " + uniqueSizes.join(", ") + ".";
    }

    const variant = product.variantes.filter((v) => v.couleur === couleur && v.taille === taille)[0];
    if (!variant) {
      trace.action = "Combinaison introuvable — options proposées";
      session.productId = null; session.couleur = null; session.taille = null; session.quantite = null;
      logTrace(session, trace);
      return "Désolée, je n'ai pas cette combinaison pour " + product.nom + ". Options disponibles : " + product.variantes.map((v) => v.couleur + " " + v.taille).join(", ") + ".";
    }

    const virt = virtualStock(product.id, variant);
    trace.verification = product.nom + " / " + variant.couleur + " / " + variant.taille + " → " + virt + " disponible(s) (stock réel " + variant.stockReel + ")";

    if (virt <= 0) {
      const alternatives = product.variantes.filter((v) => virtualStock(product.id, v) > 0);
      trace.action = "Rupture détectée — alternatives proposées";
      session.couleur = null; session.taille = null;
      logTrace(session, trace);
      if (alternatives.length) {
        session.pendingChoice = { type: "variante", options: alternatives.map((v) => ({ couleur: v.couleur, taille: v.taille })) };
        return "Désolée, " + product.nom + " " + variant.couleur + " " + variant.taille + " est en rupture 😕. Il me reste : " + alternatives.map((v) => v.couleur + " " + v.taille + " (" + virtualStock(product.id, v) + ")").join(", ") + ". Lequel voulez-vous ?";
      }
      return "Désolée, " + product.nom + " est actuellement en rupture sur tous les modèles. Je vous notifie dès le réassort ?";
    }

    trace.action = "Article disponible — quantité demandée";
    session.stage = "awaiting_quantity";
    logTrace(session, trace);
    return piocheParmi(OUVERTURES_DISPO) + " il est disponible ✅ " + product.nom + " " + variant.couleur + " " + variant.taille + " — " + formatFcfa(variant.prix) + " l'unité (" + virt + " pièce(s) en stock). Combien de pièces souhaitez-vous ?";
  }

  // Envoie (ou simule l'envoi de) la premiere photo enregistree pour cet article, si le marchand en a
  // ajoute au moins une depuis l'onglet Catalogue de /admin. Renvoie l'URL envoyee (ou null si aucune
  // photo) — utilisee uniquement pour l'affichage du panneau d'analyse du Simulateur, jamais pour decider
  // quoi que ce soit cote conversation elle-meme.
  function envoyerPhotoProduit(fromPhone, product) {
    const photos = product.photos || [];
    if (!photos.length) return null;
    const url = photos[0];
    if (fromPhone === PHONE_SIMULATEUR) {
      // Le Simulateur n'a pas de vrai numero WhatsApp destinataire : /admin affiche cette URL lui-meme
      // dans la bulle de conversation, sans appel reseau vers l'API Graph.
      return url;
    }
    envoyerImage(fromPhone, url, product.nom).catch((erreur) =>
      console.error("[" + merchantKey + "] Echec de l'envoi de la photo de l'article \"" + product.nom + "\" :", erreur)
    );
    return url;
  }

  // Enregistre la trace ET la garde sur la session (utilise par le Simulateur de /admin pour afficher le
  // panneau d'analyse en direct — voir handleMessageSimulateur ci-dessous).
  function logTrace(session, trace) {
    if (session) session.derniereTrace = trace;
    console.log("[" + merchantKey + "][conversation] « " + trace.message + " » -> " + JSON.stringify(trace.entites) + (trace.verification ? " | " + trace.verification : "") + " => " + trace.action);
  }

  function handleMessage(fromPhone, text) {
    if (!state) return "Le service redemarre, un instant s'il vous plait...";

    journaliser(fromPhone, "client", text);

    // Conversation deja mise en pause pour un humain : on reste silencieux tant que le delai n'est pas
    // ecoule (voir shared.js). Une fois le delai depasse, pauseHumainActive() remet enAttente a false et
    // le traitement normal reprend plus bas sur CE message.
    if (sh.pauseHumainActive(conversationsHumain, fromPhone)) {
      sh.ajouterMessageHistorique(conversationsHumain, fromPhone, "client", text);
      return null;
    }

    if (sh.demandeUnHumain(text)) {
      sh.demarrerPauseHumain(conversationsHumain, fromPhone, text);
      notifierMarchand("humain", [fromPhone, text]).catch((erreur) =>
        console.error("[" + merchantKey + "] Echec de la notification marchand (humain) :", erreur)
      );
      journaliser(fromPhone, "bot", sh.MESSAGE_MISE_EN_RELATION);
      return sh.MESSAGE_MISE_EN_RELATION;
    }

    // Premier contact JAMAIS vu de ce numero (avant que getSession() ne cree sa session) : on glissera la
    // mention du conseiller humain disponible a la reponse qui suit, une seule fois.
    const estPremierContact = !sessions[fromPhone] && !humanHintDonne[fromPhone];
    const session = getSession(fromPhone);
    let reponse = processMessage(session, text);
    if (estPremierContact && reponse) {
      humanHintDonne[fromPhone] = true;
      reponse += sh.MENTION_HUMAIN_DISPONIBLE;
    }
    journaliser(fromPhone, "bot", reponse);
    return reponse;
  }

  // Liste des conversations actuellement en attente d'un humain (pour l'onglet Conversations de /admin).
  function getConversationsEnAttente() {
    return sh.listerConversationsEnAttente(conversationsHumain);
  }

  // Reponse manuelle du marchand a un client mis en pause : envoie le message et remet le chrono de 10
  // minutes a zero. Retourne false si aucune conversation en attente n'existe pour ce numero.
  async function repondreConversationHumain(telephone, message) {
    const ok = sh.repondreHumain(conversationsHumain, telephone, message);
    if (!ok) return false;
    await envoyer(telephone, message);
    journaliser(telephone, "marchand", message);
    return true;
  }

  // Etat courant de la session d'UN client (apres traitement de son dernier message) - utilise par
  // server.js pour decider s'il faut accompagner la reponse texte d'un menu WhatsApp cliquable (liste
  // d'articles ou boutons Oui/Non), sans rien changer a handleMessage() ni a son contrat de retour.
  function getEtatSession(fromPhone) {
    const s = sessions[fromPhone];
    return s ? { stage: s.stage, pretPourChoix: !!s.pretPourChoix, pendingChoice: s.pendingChoice || null } : null;
  }

  // Ne renvoie JAMAIS les commandes creees par le Simulateur (source:"simulateur") — invisibles dans la
  // vraie liste de commandes du marchand et exclues de toutes les statistiques (tableau de bord, rapports).
  function getOrders() {
    if (!state) return [];
    return state.orders.filter((o) => o.source !== "simulateur");
  }

  // ---------------- Simulateur WhatsApp (onglet /admin, teste le VRAI moteur sans toucher aux vraies
  // donnees) ----------------

  // Envoie un message "comme si" il venait d'un client, sous le numero reserve PHONE_SIMULATEUR. Retourne
  // a la fois la reponse du bot et la derniere trace d'analyse (entites reconnues, verification de stock,
  // action prise) pour que /admin affiche le panneau "Moteur IA — extraction en direct" du prototype.
  function handleMessageSimulateur(text) {
    const session = getSession(PHONE_SIMULATEUR);
    session.derniereTrace = null;
    const reponse = handleMessage(PHONE_SIMULATEUR, text);
    return { reponse, trace: session.derniereTrace };
  }

  // Efface entierement la session de simulation ET toute commande/pause qu'elle aurait creee — pour
  // repartir d'un etat neutre entre deux tests (bouton "Reinitialiser" de l'onglet Simulateur).
  function resetSimulateur() {
    delete sessions[PHONE_SIMULATEUR];
    delete conversationsHumain[PHONE_SIMULATEUR];
    delete humanHintDonne[PHONE_SIMULATEUR];
    if (state) {
      const avant = state.orders.length;
      state.orders = state.orders.filter((o) => o.fromWhatsapp !== PHONE_SIMULATEUR);
      if (state.orders.length !== avant) saveState();
    }
  }

  // ---------------- Tableau de bord ----------------

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function getTableauDeBord() {
    if (!state) return null;
    const toutes = getOrders();
    const actives = toutes.filter((o) => o.statut !== "Annulée");
    const aujourdhui = actives.filter((o) => sameDay(new Date(o.dateISO), new Date()));

    const lowStock = [];
    state.catalog.forEach((p) => {
      p.variantes.forEach((v) => {
        const virt = virtualStock(p.id, v);
        const seuil = Number(v.seuilAlerte) || 0;
        if (virt <= seuil) {
          lowStock.push({ produit: p.nom, couleur: v.couleur, taille: v.taille, stockReel: v.stockReel, stockVirtuel: virt, seuil });
        }
      });
    });
    lowStock.sort((a, b) => a.stockVirtuel - b.stockVirtuel);

    const sparkline7j = [];
    for (let d = 6; d >= 0; d--) {
      const jour = new Date();
      jour.setDate(jour.getDate() - d);
      sparkline7j.push(actives.filter((o) => sameDay(new Date(o.dateISO), jour)).length);
    }

    const quantites = {};
    actives.forEach((o) => (o.items || []).forEach((it) => {
      quantites[it.produit] = (quantites[it.produit] || 0) + (Number(it.quantite) || 0);
    }));
    const topProduits = Object.keys(quantites)
      .map((nom) => ({ nom, quantite: quantites[nom] }))
      .sort((a, b) => b.quantite - a.quantite)
      .slice(0, 4);

    return {
      commandesAujourdhui: aujourdhui.length,
      caJour: aujourdhui.reduce((s, o) => s + (o.prix || 0), 0),
      alertesStock: lowStock.length,
      ruptures: lowStock.filter((v) => v.stockVirtuel <= 0).length,
      conversationsEnAttente: sh.listerConversationsEnAttente(conversationsHumain).length,
      sparkline7j,
      topProduits,
      stockASurveiller: lowStock
    };
  }

  // ---------------- Rapports (periode) ----------------

  function debutPeriode(periode, dateReference) {
    const d = new Date(dateReference);
    if (periode === "semaine") {
      const jourSemaine = (d.getDay() + 6) % 7; // 0 = lundi
      d.setDate(d.getDate() - jourSemaine);
    } else if (periode === "mois") {
      d.setDate(1);
    }
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function finPeriode(periode, debut) {
    const f = new Date(debut);
    if (periode === "jour") f.setDate(f.getDate() + 1);
    else if (periode === "semaine") f.setDate(f.getDate() + 7);
    else f.setMonth(f.getMonth() + 1);
    return f;
  }

  // Rapport agrege sur une periode (jour/semaine/mois autour de `dateReference`), filtrable par article.
  function getRapportCommandes({ periode, dateReference, articleId }) {
    const debut = debutPeriode(periode || "jour", dateReference || new Date().toISOString());
    const fin = finPeriode(periode || "jour", debut);
    const dansPeriode = getOrders().filter((o) => {
      const d = new Date(o.dateISO);
      return d >= debut && d < fin;
    });
    const filtrees = articleId && articleId !== "tous"
      ? dansPeriode.filter((o) => (o.items || []).some((it) => it.productId === articleId))
      : dansPeriode;

    const parStatut = {};
    STATUT_LIST.forEach((s) => (parStatut[s] = 0));
    let ca = 0;
    const quantitesParArticle = {};
    filtrees.forEach((o) => {
      parStatut[o.statut] = (parStatut[o.statut] || 0) + 1;
      if (o.statut !== "Annulée") {
        ca += o.prix || 0;
        (o.items || []).forEach((it) => {
          if (articleId && articleId !== "tous" && it.productId !== articleId) return;
          quantitesParArticle[it.produit] = (quantitesParArticle[it.produit] || 0) + (Number(it.quantite) || 0);
        });
      }
    });

    return {
      debutISO: debut.toISOString(),
      finISO: fin.toISOString(),
      nbCommandes: filtrees.length,
      chiffreAffaires: ca,
      parStatut,
      parArticle: Object.keys(quantitesParArticle).map((nom) => ({ nom, quantite: quantitesParArticle[nom] })).sort((a, b) => b.quantite - a.quantite)
    };
  }

  // ---------------- Inventaire : instantanes enregistres + comparaison ----------------

  function getInventaireActuel() {
    if (!state) return [];
    const lignes = [];
    state.catalog.forEach((p) => {
      p.variantes.forEach((v) => {
        lignes.push({ produit: p.nom, couleur: v.couleur, taille: v.taille, stockReel: v.stockReel, prix: v.prix });
      });
    });
    return lignes;
  }

  function listerInstantanesInventaire() {
    return state ? state.inventorySnapshots : [];
  }

  function enregistrerInstantaneInventaire(nom) {
    if (!state) return null;
    const snapshot = {
      id: "inv" + Date.now(),
      nom: nom && String(nom).trim() ? String(nom).trim() : "Instantané du " + new Date().toLocaleDateString("fr-FR"),
      dateISO: new Date().toISOString(),
      lignes: getInventaireActuel()
    };
    state.inventorySnapshots.push(snapshot);
    saveState();
    return snapshot;
  }

  function supprimerInstantaneInventaire(id) {
    if (!state) return false;
    const avant = state.inventorySnapshots.length;
    state.inventorySnapshots = state.inventorySnapshots.filter((s) => s.id !== id);
    if (state.inventorySnapshots.length !== avant) { saveState(); return true; }
    return false;
  }

  // Renvoie le catalogue avec, pour chaque variante, un "stockVirtuel" calcule a la volee (stock reel
  // moins les quantites deja engagees dans des commandes Confirmee/Expediee) — c'est cette valeur que le
  // bot verifie avant de proposer un article, mais jusqu'ici elle n'etait visible nulle part cote
  // marchand. Champ en lecture seule : ne pas le renvoyer tel quel a updateCatalog (il est recalcule a
  // chaque lecture, donc meme s'il est renvoye par erreur il est simplement ignore/ecrase au prochain
  // chargement).
  function getCatalog() {
    if (!state) return [];
    return state.catalog.map((p) => ({
      ...p,
      variantes: p.variantes.map((v) => ({ ...v, stockVirtuel: virtualStock(p.id, v) }))
    }));
  }

  function getSettings() {
    return state ? state.settings : {};
  }

  function updateSettings(patch) {
    if (!state) return;
    state.settings = Object.assign({}, state.settings, patch);
    saveState();
    return state.settings;
  }

  // Remplace l'integralite du catalogue (utilise par l'interface d'administration). Validation minimale :
  // on exige un tableau ; la structure detaillee de chaque article est du ressort de l'appelant (API).
  function updateCatalog(newCatalog) {
    if (!state || !Array.isArray(newCatalog)) return null;
    state.catalog = newCatalog;
    saveState();
    return state.catalog;
  }

  // Ajoute une photo (URL deja hebergee, voir storage.js) a un article. Renvoie l'article mis a jour, ou
  // null si l'article n'existe pas.
  function ajouterPhotoProduit(productId, url) {
    if (!state) return null;
    const p = state.catalog.filter((x) => x.id === productId)[0];
    if (!p) return null;
    if (!Array.isArray(p.photos)) p.photos = [];
    p.photos.push(url);
    saveState();
    return p;
  }

  // Retire une photo (par son URL) d'un article. Ne supprime PAS le fichier sur R2 elle-meme — c'est
  // server.js qui s'en charge (storage.supprimerPhotoProduit), cette fonction ne touche que le catalogue.
  function supprimerPhotoProduit(productId, url) {
    if (!state) return null;
    const p = state.catalog.filter((x) => x.id === productId)[0];
    if (!p) return null;
    p.photos = (p.photos || []).filter((u) => u !== url);
    saveState();
    return p;
  }

  function updateOrderStatus(orderId, newStatus, raisonAnnulation) {
    if (!state) return null;
    const order = state.orders.filter((o) => o.id === Number(orderId))[0];
    if (!order) return null;
    applyStatusChange(order, newStatus, raisonAnnulation);
    return order;
  }

  return {
    type: "catalogue",
    init,
    handleMessage,
    getOrders,
    getCatalog,
    getSettings,
    updateSettings,
    updateCatalog,
    ajouterPhotoProduit,
    supprimerPhotoProduit,
    updateOrderStatus,
    getConversationsEnAttente,
    repondreConversationHumain,
    getEtatSession,
    handleMessageSimulateur,
    resetSimulateur,
    getTableauDeBord,
    getRapportCommandes,
    listerInstantanesInventaire,
    enregistrerInstantaneInventaire,
    supprimerInstantaneInventaire,
    getInventaireActuel
  };
}

module.exports = createCatalogEngine;
