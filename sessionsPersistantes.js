// IzyVendeur - Etape 72 : sauvegarde des sessions de conversation des clients.
//
// Chaque moteur (catalogue, service, hebergement) et le routeur hybride gardent le fil de la conversation de chaque
// client dans un objet en memoire (`sessions`, `etats`). Ce module recopie ces objets dans la base (voir db.js,
// table sessions_clients) a chaque message, et les recharge au demarrage : un redemarrage du serveur ne fait plus
// perdre un panier, une question en attente ni un rendez-vous « Nouvelle » qui attend le « oui » du client.
//
// Aucun effet sur le journal des conversations (conversation_log, onglet Historique de /admin).
//
// Utilisation :
//   const persistance = sessionsPersistantes.creer({ cle, sessions, conversationsHumain, regle, ignorer });
//   await persistance.charger();          // au demarrage du moteur, une fois son etat charge
//   persistance.enregistrer(telephone);   // apres chaque message (ou changement) de ce client
//   persistance.balayer();                // periodiquement : applique les durees de vie
//
// `regle(session, ageMs)` est propre a chaque moteur : renvoie la session a conserver (la meme, ou une version
// allegee), ou null pour l'oublier completement.

const db = require("./db");

const JOUR_MS = 24 * 60 * 60 * 1000;
const DUREE_MAX_JOURS = 90;           // une session sans aucun message depuis ce delai est supprimee
const RAFRAICHIR_ACTIVITE_MS = 60 * 60 * 1000; // une session inchangee n'est reecrite qu'une fois par heure

// Ecritures en cours vers la base, tous moteurs confondus : permet d'attendre leur fin avant un arret volontaire du serveur.
const ecrituresEnCours = new Set();
function attendreEcritures() { return Promise.all(Array.from(ecrituresEnCours).map((p) => p.catch(() => {}))); }

const CHAMPS_NON_SAUVEGARDES = ["derniereTrace"]; // trace de debogage du Simulateur : volumineuse, sans valeur ensuite

function sansTransitoire(session) {
  const copie = {};
  Object.keys(session).forEach((k) => { if (CHAMPS_NON_SAUVEGARDES.indexOf(k) === -1) copie[k] = session[k]; });
  return copie;
}

// Une session « vide » ne contient rien a retenir (pas de langue, pas d'etape en cours, pas de panier ni d'element en
// attente) : on supprime sa ligne plutot que de la garder.
function estVide(s) {
  if (!s) return true;
  if (s.langue) return false;
  if (s.etape || s.texteInitial) return false; // etat de routage hybride (hybride.js)
  if (s.stage && s.stage !== "idle") return false;
  if (s.cart && s.cart.length) return false;
  if (s.pendingOrderId || s.pendingAppointmentId || s.pendingSejourId || s.reportApptId || s.reportSejourId) return false;
  if (s.texteAvantLangue || s.gateLangueEnvoyee) return false;
  return true;
}

function creer(o) {
  const cle = o.cle;
  const sessions = o.sessions;
  const humain = o.conversationsHumain || null;
  const regle = o.regle || ((s) => s);
  const ignorer = o.ignorer || [];
  const journalErreur = o.journalErreur || ((m, e) => console.error(m, e));

  const activite = {};   // telephone -> dernier message (ms)
  const dernier = {};    // telephone -> dernier instantane ecrit (texte, sans l'horodatage)
  const dernierEcritA = {};
  const enVol = {};      // telephone -> true tant qu'une ecriture est en cours
  const enAttente = {};  // telephone -> prochaine donnee a ecrire (la plus recente seulement)

  function ecrire(tel, data) {
    if (enVol[tel]) { enAttente[tel] = data; return; }
    enVol[tel] = true;
    const fin = () => {
      enVol[tel] = false;
      if (enAttente[tel]) { const suivant = enAttente[tel]; delete enAttente[tel]; ecrire(tel, suivant); }
    };
    const promesse = data === null ? db.supprimerSessionClient(cle, tel) : db.enregistrerSessionClient(cle, tel, data);
    ecrituresEnCours.add(promesse);
    const termine = () => { ecrituresEnCours.delete(promesse); fin(); };
    promesse.then(termine, (e) => { journalErreur("[" + cle + "] Sauvegarde de session impossible (le fil de ce client pourrait etre perdu au redemarrage) :", e); termine(); });
  }

  function instantane(tel) {
    const s = sessions[tel];
    if (!s || estVide(s)) return null;
    const h = humain && humain[tel] && humain[tel].enAttente ? humain[tel] : null;
    return { s: sansTransitoire(s), h };
  }

  // `conserverActivite` : la sauvegarde vient d'un nettoyage (pas d'un message du client), l'horodatage du dernier
  // message ne doit donc pas etre remis a « maintenant ».
  function enregistrer(tel, conserverActivite) {
    if (!tel || ignorer.indexOf(tel) !== -1) return;
    const maintenant = Date.now();
    if (!(conserverActivite && activite[tel])) activite[tel] = maintenant;
    const snap = instantane(tel);
    if (snap === null) {
      if (dernier[tel] !== null && dernier[tel] !== undefined) { dernier[tel] = null; ecrire(tel, null); }
      return;
    }
    const texte = JSON.stringify(snap);
    if (texte === dernier[tel] && maintenant - (dernierEcritA[tel] || 0) < RAFRAICHIR_ACTIVITE_MS) return;
    dernier[tel] = texte;
    dernierEcritA[tel] = maintenant;
    ecrire(tel, Object.assign({ a: activite[tel] }, snap));
  }

  async function charger() {
    let lignes = [];
    try { lignes = await db.chargerSessionsClients(cle); }
    catch (e) { journalErreur("[" + cle + "] Chargement des sessions impossible (on repart sans) :", e); return 0; }
    const maintenant = Date.now();
    let n = 0;
    lignes.forEach((l) => {
      const d = l.data || {};
      const a = Number(d.a) || l.updatedAtMs || maintenant;
      const age = maintenant - a;
      const brute = d.s;
      if (!brute || typeof brute !== "object") { ecrire(l.telephone, null); return; }
      let gardee = null;
      try { gardee = regle(brute, age); } catch (e) { gardee = null; }
      if (!gardee) { ecrire(l.telephone, null); return; }
      sessions[l.telephone] = gardee;
      activite[l.telephone] = a;
      if (humain && d.h && d.h.enAttente) humain[l.telephone] = d.h;
      dernier[l.telephone] = JSON.stringify({ s: sansTransitoire(gardee), h: humain && humain[l.telephone] && humain[l.telephone].enAttente ? humain[l.telephone] : null });
      dernierEcritA[l.telephone] = maintenant;
      if (gardee !== brute) enregistrer(l.telephone, true);
      n++;
    });
    return n;
  }

  // Applique les durees de vie aux sessions deja en memoire (appel periodique).
  function balayer() {
    const maintenant = Date.now();
    Object.keys(sessions).forEach((tel) => {
      if (ignorer.indexOf(tel) !== -1) return;
      const a = activite[tel];
      if (!a) return;
      const age = maintenant - a;
      let gardee = null;
      try { gardee = regle(sessions[tel], age); } catch (e) { gardee = sessions[tel]; }
      if (!gardee) { delete sessions[tel]; if (humain) delete humain[tel]; delete activite[tel]; delete dernier[tel]; ecrire(tel, null); return; }
      if (gardee !== sessions[tel]) { sessions[tel] = gardee; enregistrer(tel, true); }
    });
  }

  return { charger, enregistrer, balayer };
}

module.exports = { creer, estVide, attendreEcritures, JOUR_MS, DUREE_MAX_JOURS };
