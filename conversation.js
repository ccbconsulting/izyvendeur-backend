// IzyVendeur - Moteur de conversation (porte depuis le prototype HTML "Simulateur WhatsApp")
//
// Ce module reproduit exactement la logique du simulateur du prototype :
//   - reconnaissance de l'article/couleur/taille demandes dans le message du client
//   - verification du stock virtuel (stock reel moins les commandes deja Confirmee/Expediee)
//   - panier multi-articles, demande des infos de livraison, recapitulatif, confirmation
//   - creation d'une vraie commande, avec message de confirmation automatique
//
// Difference principale avec le prototype : au lieu de vivre dans le navigateur (localStorage,
// une seule "session" a la fois), ce module garde une conversation en cours PAR NUMERO DE CLIENT
// (plusieurs clients peuvent discuter en meme temps avec le meme marchand), et sauvegarde l'etat
// (catalogue + commandes) dans un fichier data.json a cote du serveur, pour survivre aux redemarrages.

const fs = require("fs");
const path = require("path");
const { SEED_CATALOG, PROD_KEYWORDS, DEFAULT_AUTO_CONFIRM_MESSAGE } = require("./catalog");

const DATA_FILE = path.join(__dirname, "data.json");
const RESERVING_STATUSES = ["Confirmée", "Expédiée"];
const STOPWORDS = ["de", "du", "des", "la", "le", "les", "en", "à", "au", "aux", "et", "un", "une", "2", "3"];

// ---------------- Chargement / sauvegarde de l'etat (catalogue + commandes) ----------------

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.catalog && parsed.orders) {
        if (!parsed.settings) parsed.settings = { autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE };
        return parsed;
      }
    }
  } catch (erreur) {
    console.error("Erreur de lecture de data.json, on repart du catalogue de depart :", erreur);
  }
  return {
    catalog: JSON.parse(JSON.stringify(SEED_CATALOG)),
    orders: [],
    nextId: 1,
    settings: { autoConfirmMessage: DEFAULT_AUTO_CONFIRM_MESSAGE }
  };
}

let state = loadState();

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (erreur) {
    console.error("Erreur d'ecriture de data.json (l'etat ne sera pas conserve au redemarrage) :", erreur);
  }
}

// ---------------- Sessions de conversation, une par numero de client ----------------
// En memoire uniquement : si le serveur redemarre en plein milieu d'une commande, le client
// devra recommencer sa phrase. Acceptable pour cette etape ; une vraie base de donnees remplacera
// ca plus tard (voir README).

const sessions = {};

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
    pendingOrderId: null
  };
}

function getSession(fromPhone) {
  if (!sessions[fromPhone]) sessions[fromPhone] = freshSession();
  return sessions[fromPhone];
}

// ---------------- Utilitaires ----------------

function formatFcfa(n) {
  return (n || 0).toLocaleString("fr-FR") + " FCFA";
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

// Reconnait les phrases par lesquelles un client signale qu'il veut abandonner l'article en cours
// de selection sans en nommer un nouveau ("je veux autre chose", "un autre article"...).
function parseWantsSomethingElse(text) {
  const t = text.toLowerCase();
  return /\b(autre\s+chose|un\s+autre\s+article|un\s+autre\s+produit|autre\s+article|autre\s+produit|pas\s+celui[\s-]l[àa]|pas\s+ça|pas\s+ca|change(?:r)?\s+d['’]article|change(?:r)?\s+d['’]avis|oublie[rz]?\s+(?:ça|ca|cela)|annule[rz]?\s+(?:ça|ca|cela)?|laisse\s+tomber|recommen[cç]ons|recommencer)\b/.test(t);
}

function parseAffirmative(text) {
  const t = text.toLowerCase().trim();
  if (t === "o") return true;
  return /^(oui|ouais|ouep|d['’]accord|daccord|ok(?:ay)?|yes|exact(?:ement)?|parfait|je\s*confirme|confirm(?:e|é)?|c['’]est\s*(?:ça|bon)|banco|allons[- ]y|top)\b/.test(t);
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

// ---------------- Reconnaissance produit / couleur / taille dans le texte du client ----------------
// Base sur le catalogue EN DIRECT : tout article/couleur/taille du catalogue est reconnaissable,
// sans dictionnaire fige a maintenir a la main.

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

// ---------------- Commandes ----------------

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
    statut: "Nouvelle",
    raisonAnnulation: null,
    source: "whatsapp"
  };
  state.orders.push(order);
  saveState();
  return order;
}

function applyStatusChange(order, newStatus) {
  const oldStatus = order.statut;
  if (oldStatus === newStatus) return;
  (order.items || []).forEach((it) => {
    const variant = findVariant(it.productId, it.couleur, it.taille);
    if (!variant) return;
    const qty = it.quantite || 1;
    if (newStatus === "Livrée" && oldStatus !== "Livrée") variant.stockReel = Math.max(0, variant.stockReel - qty);
    if (oldStatus === "Livrée" && newStatus !== "Livrée") variant.stockReel += qty;
  });
  order.statut = newStatus;
  if (newStatus !== "Annulée") order.raisonAnnulation = null;
  saveState();
}

// ---------------- Coeur de la conversation ----------------
// Reproduit exactement la machine a etats du prototype (handleUserMessage), mais retourne le texte
// de la reponse au lieu de l'afficher dans une bulle de chat.

function processMessage(session, text) {
  const trace = { message: text, entites: {}, verification: null, action: null };

  if (session.stage === "awaiting_quantity") {
    const product0 = state.catalog.filter((p) => p.id === session.productId)[0];
    const variant0 = product0 ? product0.variantes.filter((v) => v.couleur === session.couleur && v.taille === session.taille)[0] : null;
    const virt0 = variant0 ? virtualStock(product0.id, variant0) : 0;
    const qty = parseQuantity(text);
    trace.entites = { "Quantité demandée": qty != null ? qty : "—", "Stock virtuel disponible": virt0 };
    if (qty == null || qty < 1) {
      trace.action = "Quantité non comprise — nouvelle demande";
      logTrace(trace);
      return "Merci d'indiquer un nombre de pièces (ex : 1, 2, 3…).";
    }
    if (qty > virt0) {
      trace.action = "Quantité demandée supérieure au stock virtuel disponible";
      logTrace(trace);
      return "Il ne me reste que " + virt0 + " pièce(s) disponible(s) pour " + product0.nom + " " + variant0.couleur + " " + variant0.taille + ". Combien en voulez-vous (max " + virt0 + ") ?";
    }
    session.cart.push({ productId: product0.id, produit: product0.nom, couleur: variant0.couleur, taille: variant0.taille, quantite: qty, prixUnitaire: variant0.prix });
    session.productId = null; session.couleur = null; session.taille = null; session.quantite = null;
    session.stage = "awaiting_more_items";
    trace.action = "Article ajouté au panier — proposition d'ajouter un autre article";
    logTrace(trace);
    return "Ajouté au panier ✅ " + qty + " × " + product0.nom + " " + variant0.couleur + " " + variant0.taille + " — " + formatFcfa(variant0.prix * qty) + ".\nSouhaitez-vous ajouter un autre article à votre commande ? (oui / non)";
  }

  if (session.stage === "awaiting_more_items") {
    trace.entites = { "Réponse client": text };
    if (parseAffirmative(text)) {
      session.stage = "idle";
      trace.action = "Client souhaite ajouter un autre article au panier";
      logTrace(trace);
      return "Très bien, quel autre article souhaitez-vous ?";
    }
    session.stage = "awaiting_delivery";
    trace.action = "Panier finalisé (" + session.cart.length + " article(s)) — infos de livraison demandées";
    logTrace(trace);
    return "Voici votre panier :\n" + describeItems(session.cart) + "\nTotal : " + formatFcfa(itemsTotal(session.cart)) + "\n\nPour finaliser, envoyez-moi votre numéro et votre adresse de livraison.";
  }

  if (session.stage === "awaiting_delivery") {
    const phoneMatch = text.match(/(\+?237)?[\s.-]?[62]\d{7,8}/);
    let remaining = text;
    if (phoneMatch) { session.telephone = phoneMatch[0].trim(); remaining = text.replace(phoneMatch[0], "").trim(); }
    if (remaining && remaining.replace(/[,\-\s]/g, "").length > 3) session.adresse = remaining.replace(/^[,\-\s]+/, "");
    trace.entites = { "Téléphone": session.telephone || "—", "Adresse": session.adresse || "—" };
    if (session.telephone && session.adresse) {
      const order = createOrderFromCart(session);
      session.pendingOrderId = order.id;
      session.stage = "awaiting_order_confirmation";
      trace.action = "Commande " + orderRef(order) + " créée (statut Nouvelle) — récapitulatif envoyé, confirmation demandée";
      logTrace(trace);
      return "Récapitulatif de votre commande (" + orderRef(order) + ") :\n" + describeItems(order.items) + "\nTotal : " + formatFcfa(order.prix) + "\nLivraison : " + session.adresse + "\n\nConfirmez-vous cette commande ? (oui / non)";
    }
    const missing = [];
    if (!session.telephone) missing.push("numéro de téléphone");
    if (!session.adresse) missing.push("adresse de livraison");
    trace.action = "Information manquante demandée : " + missing.join(" et ");
    logTrace(trace);
    return "Il me manque encore : " + missing.join(" et ") + ".";
  }

  if (session.stage === "awaiting_order_confirmation") {
    const pendingOrder = state.orders.filter((x) => x.id === session.pendingOrderId)[0];
    trace.entites = { "Réponse client": text };
    let reply;
    if (pendingOrder && parseAffirmative(text)) {
      applyStatusChange(pendingOrder, "Confirmée");
      trace.action = "Client confirme — commande " + orderRef(pendingOrder) + " passée automatiquement en Confirmée";
      reply = (state.settings && state.settings.autoConfirmMessage) || DEFAULT_AUTO_CONFIRM_MESSAGE;
    } else if (pendingOrder) {
      trace.action = "Pas de confirmation claire — commande " + orderRef(pendingOrder) + " reste en Nouvelle, à confirmer manuellement";
      reply = "Très bien, votre commande reste enregistrée. Notre équipe reviendra vers vous pour la confirmer.";
    } else {
      reply = "Très bien, votre commande reste enregistrée.";
    }
    Object.assign(session, freshSession());
    logTrace(trace);
    return reply;
  }

  // Etat "idle" (ou reprise en cours) : on essaie de reconnaitre article / couleur / taille.
  let produitId = matchProduct(text);
  if (!produitId && session.productId && parseWantsSomethingElse(text)) {
    // Le client signale clairement qu'il veut autre chose, sans nommer un article precis :
    // on efface la selection en cours au lieu de rester coince dessus.
    session.productId = null; session.couleur = null; session.taille = null; session.quantite = null;
    trace.action = "Client veut changer d'article — sélection précédente effacée";
    logTrace(trace);
    return "Pas de souci ! Quel article vous intéresse ? Nous avons : " + state.catalog.map((p) => p.nom).join(", ") + ".";
  }
  produitId = produitId || session.productId;
  const couleur = matchCouleur(text) || (produitId === session.productId ? session.couleur : null);
  let taille = matchTaille(text) || (produitId === session.productId ? session.taille : null);
  session.productId = produitId; session.couleur = couleur; session.taille = taille;

  trace.entites = {
    "Produit": produitId ? state.catalog.filter((p) => p.id === produitId)[0].nom : "—",
    "Couleur": couleur || "—",
    "Taille": taille || "—"
  };

  if (!produitId) {
    trace.action = "Précision demandée : quel article ?";
    logTrace(trace);
    return "Bonjour ! Quel article vous intéresse ? Nous avons : " + state.catalog.map((p) => p.nom).join(", ") + ".";
  }

  const product = state.catalog.filter((p) => p.id === produitId)[0];
  const availableColors = product.variantes.map((v) => v.couleur).filter((v, i, a) => a.indexOf(v) === i);

  if (!couleur) {
    trace.action = "Précision demandée : quelle couleur ?";
    logTrace(trace);
    return product.nom + " — quelle couleur souhaitez-vous ? Disponible en : " + availableColors.join(", ") + ".";
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
    logTrace(trace);
    return "Quelle taille pour " + product.nom + " " + couleur + " ? Disponible : " + uniqueSizes.join(", ") + ".";
  }

  const variant = product.variantes.filter((v) => v.couleur === couleur && v.taille === taille)[0];
  if (!variant) {
    trace.action = "Combinaison introuvable — options proposées";
    session.productId = null; session.couleur = null; session.taille = null; session.quantite = null;
    logTrace(trace);
    return "Désolée, je n'ai pas cette combinaison pour " + product.nom + ". Options disponibles : " + product.variantes.map((v) => v.couleur + " " + v.taille).join(", ") + ".";
  }

  const virt = virtualStock(product.id, variant);
  trace.verification = product.nom + " / " + variant.couleur + " / " + variant.taille + " → " + virt + " disponible(s) (stock réel " + variant.stockReel + ")";

  if (virt <= 0) {
    const alternatives = product.variantes.filter((v) => virtualStock(product.id, v) > 0);
    trace.action = "Rupture détectée — alternatives proposées";
    session.couleur = null; session.taille = null;
    logTrace(trace);
    if (alternatives.length) {
      return "Désolée, " + product.nom + " " + variant.couleur + " " + variant.taille + " est en rupture 😕. Il me reste : " + alternatives.map((v) => v.couleur + " " + v.taille + " (" + virtualStock(product.id, v) + ")").join(", ") + ". Lequel voulez-vous ?";
    }
    return "Désolée, " + product.nom + " est actuellement en rupture sur tous les modèles. Je vous notifie dès le réassort ?";
  }

  trace.action = "Article disponible — quantité demandée";
  session.stage = "awaiting_quantity";
  logTrace(trace);
  return "Il est disponible ✅ " + product.nom + " " + variant.couleur + " " + variant.taille + " — " + formatFcfa(variant.prix) + " l'unité (" + virt + " pièce(s) en stock). Combien de pièces souhaitez-vous ?";
}

function logTrace(trace) {
  // Visible dans les logs Render : utile pour comprendre ce que le moteur a compris, sans DOM.
  console.log("[conversation] « " + trace.message + " » -> " + JSON.stringify(trace.entites) + (trace.verification ? " | " + trace.verification : "") + " => " + trace.action);
}

// ---------------- Point d'entree public ----------------

function handleMessage(fromPhone, text) {
  const session = getSession(fromPhone);
  return processMessage(session, text);
}

function getOrders() {
  return state.orders;
}

function getCatalog() {
  return state.catalog;
}

module.exports = { handleMessage, getOrders, getCatalog };
