"use strict";
// Tests unitaires de l'Etape 85 : compteurs, regroupement des alertes, reglages de notification.
const assert = require("assert");
const alertes = require("../alertes");
const db = require("../db");
let nb = 0; const ok = (nom, f) => { f(); nb++; console.log("  ok - " + nom); };
const okA = async (nom, f) => { await f(); nb++; console.log("  ok - " + nom); };

function faux(opts) {
  const o = opts || {};
  const moteurs = {};
  if (o.commandes) moteurs.catalogue = { getOrders: () => o.commandes, getEnseigne: () => ({ magasins: o.magasins || [] }), getConversationsEnAttente: () => o.conv || [] };
  if (o.rdv) moteurs.service = { getAppointments: () => o.rdv, getConversationsEnAttente: () => [], marquerVus: () => { let n = 0; o.rdv.forEach((a) => { if (a.source !== "simulateur" && a.statut === "Confirmé" && !a.vuLe) { a.vuLe = "x"; n++; } }); return n; } };
  if (o.sejours) moteurs.hebergement = { getSejours: () => o.sejours, getConversationsEnAttente: () => [] };
  if (o.billets) moteurs.transport = { getReservations: () => o.billets, getConversationsEnAttente: () => [] };
  return { merchant: Object.assign({ id: "m" }, o.merchant || {}), moteurs };
}

(async () => {
  console.log("Compteurs");
  const e = faux({
    commandes: [
      { id: 1, statut: "Confirmée", source: "whatsapp" }, { id: 2, statut: "Nouvelle", source: "whatsapp" },
      { id: 3, statut: "Confirmée", source: "pos" }, { id: 4, statut: "Livrée", source: "whatsapp" },
      { id: 5, statut: "Confirmée", source: "whatsapp", magasinId: "M1", prepa: "nouvelle" },
      { id: 6, statut: "Confirmée", source: "whatsapp", magasinId: "M2", prepa: "en_preparation" }
    ],
    conv: [{ telephone: "1" }, { telephone: "2" }],
    rdv: [{ id: 1, statut: "Confirmé" }, { id: 2, statut: "Confirmé", vuLe: "x" }, { id: 3, statut: "Nouvelle" }, { id: 4, statut: "Confirmé", source: "simulateur" }],
    merchant: { optionEnseigne: false }
  });
  ok("proprietaire : commandes = Confirmée hors caisse, rdv non vus, conversations", () => {
    const c = alertes.calculerCompteurs(e, { gestionnaire: true, roles: [] });
    assert.strictEqual(c.commandes, 3); assert.strictEqual(c.rendezvous, 1); assert.strictEqual(c.conversations, 2); assert.strictEqual(c.preparation, undefined);
    assert.strictEqual(c.total, 6);
  });
  ok("employe sans role : aucun compteur ne fuit", () => {
    const c = alertes.calculerCompteurs(e, { gestionnaire: false, roles: ["inventaire"] });
    assert.deepStrictEqual(Object.keys(c), ["total"]); assert.strictEqual(c.total, 0);
  });
  ok("employe commandes seulement", () => {
    const c = alertes.calculerCompteurs(e, { gestionnaire: false, roles: ["commandes"] });
    assert.strictEqual(c.commandes, 3); assert.strictEqual(c.rendezvous, undefined); assert.strictEqual(c.conversations, undefined);
  });
  const ens = faux({ commandes: e.moteurs.catalogue.getOrders(), merchant: { optionEnseigne: true } });
  ok("enseigne : commandes de retrait comptees dans preparation, pas dans commandes", () => {
    const c = alertes.calculerCompteurs(ens, { gestionnaire: true, roles: [] });
    assert.strictEqual(c.commandes, 1); assert.strictEqual(c.preparation, 1);
  });
  ok("enseigne : employe rattache a un magasin ne voit que le sien", () => {
    const c1 = alertes.calculerCompteurs(ens, { gestionnaire: false, roles: ["preparation"], magasinImpose: "M1" });
    const c2 = alertes.calculerCompteurs(ens, { gestionnaire: false, roles: ["preparation"], magasinImpose: "M2" });
    assert.strictEqual(c1.preparation, 1); assert.strictEqual(c2.preparation, 0); assert.strictEqual(c1.commandes, undefined);
  });
  ok("preparation absente si l'option enseigne est fermee", () => {
    assert.strictEqual(alertes.calculerCompteurs(e, { gestionnaire: true }).preparation, undefined);
  });
  ok("tout marquer comme vu retire la pastille sans changer le statut", () => {
    assert.strictEqual(alertes.marquerVus(e, "rendezvous"), 1);
    assert.strictEqual(alertes.calculerCompteurs(e, { gestionnaire: true }).rendezvous, 0);
    assert.strictEqual(e.moteurs.service.getAppointments()[0].statut, "Confirmé");
  });
  ok("refsATraiter", () => {
    const r = alertes.refsATraiter(faux({ commandes: [{ id: 7, statut: "Confirmée" }, { id: 8, statut: "Livrée" }], sejours: [{ id: 2, statut: "Confirmé", reference: "SEJ-0002" }] }));
    assert.ok(r.has("CMD-0007")); assert.ok(!r.has("CMD-0008")); assert.ok(r.has("SEJ-0002"));
  });

  console.log("Regroupement");
  function banc(intervalleMin, aTraiter) {
    let t = 1000000; const envoyes = []; const timers = [];
    const f = alertes.creerFileAlertes({
      intervalleMs: () => intervalleMin * 60000,
      estEncoreATraiter: (ev) => (aTraiter ? aTraiter(ev) : true),
      envoyerEvenement: async (ev) => { envoyes.push({ k: "evt", cle: ev.cle }); },
      envoyerResume: async (evs) => { envoyes.push({ k: "resume", n: evs.length, libelle: alertes.libelleResume(evs) }); },
      maintenant: () => t, planifier: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, annuler: () => {}
    });
    return { f, envoyes, timers, avance: (min) => { t += min * 60000; } };
  }
  const ev = (type, cle) => ({ type, cle, params: [cle], destinataires: ["237600000001"] });
  await okA("sans regroupement : tout part immediatement", async () => {
    const b = banc(0); await b.f.soumettre(ev("commande_confirmee", "CMD-1")); await b.f.soumettre(ev("commande_confirmee", "CMD-2"));
    assert.strictEqual(b.envoyes.length, 2); assert.strictEqual(b.timers.length, 0);
  });
  await okA("premiere alerte immediate, suivantes en file, UN resume", async () => {
    const b = banc(10);
    await b.f.soumettre(ev("commande_confirmee", "CMD-1")); assert.deepStrictEqual(b.envoyes.map((x) => x.k), ["evt"]);
    b.avance(2); await b.f.soumettre(ev("commande_confirmee", "CMD-2"));
    b.avance(3); await b.f.soumettre(ev("rdv_confirme", "RDV-1"));
    assert.strictEqual(b.envoyes.length, 1); assert.strictEqual(b.timers.length, 1);
    assert.strictEqual(b.timers[0].ms, 8 * 60000); // creee a +2 min : la pause se termine 10 min apres la premiere alerte
    b.avance(5); await b.timers[0].fn(); await new Promise((r) => setImmediate(r));
    assert.strictEqual(b.envoyes.length, 2); assert.strictEqual(b.envoyes[1].k, "resume"); assert.strictEqual(b.envoyes[1].n, 2);
    assert.strictEqual(b.envoyes[1].libelle, "1 commande, 1 rendez-vous ou réservation");
  });
  await okA("un seul evenement en file : alerte normale (pas de resume)", async () => {
    const b = banc(10); await b.f.soumettre(ev("commande_confirmee", "CMD-1"));
    b.avance(1); await b.f.soumettre(ev("commande_confirmee", "CMD-2")); b.avance(9); await b.timers[0].fn();
    assert.deepStrictEqual(b.envoyes.map((x) => x.k), ["evt", "evt"]);
  });
  await okA("evenement deja traite a la fin de la pause : rien n'est envoye", async () => {
    const traites = new Set(); const b = banc(10, (e) => !traites.has(e.cle));
    await b.f.soumettre(ev("commande_confirmee", "CMD-1")); b.avance(1); await b.f.soumettre(ev("commande_confirmee", "CMD-2"));
    traites.add("CMD-2"); b.avance(9); await b.timers[0].fn();
    assert.strictEqual(b.envoyes.length, 1);
  });
  await okA("apres une pause vide, la prochaine alerte repart immediatement", async () => {
    const b = banc(10); await b.f.soumettre(ev("commande_confirmee", "CMD-1")); b.avance(30);
    await b.f.soumettre(ev("commande_confirmee", "CMD-2")); assert.strictEqual(b.envoyes.length, 2);
  });
  await okA("cadence : un evenement par minute pendant 60 min => au plus 1 envoi par tranche de 10 min", async () => {
    const b = banc(10); const echeances = [];
    for (let minute = 0; minute < 60; minute++) {
      await b.f.soumettre(ev("commande_confirmee", "CMD-" + minute));
      while (b.timers.length) { const t = b.timers.shift(); echeances.push({ a: minute + Math.ceil(t.ms / 60000), t }); }
      b.avance(1);
      for (const e of echeances.filter((x) => x.a <= minute + 1)) { echeances.splice(echeances.indexOf(e), 1); await e.t.fn(); }
    }
    assert.ok(b.envoyes.length <= 7, "trop d'envois: " + b.envoyes.length);
    assert.ok(b.envoyes.length >= 5, "pas assez d'envois: " + b.envoyes.length);
  });
  ok("alertes maximum par jour", () => { assert.strictEqual(alertes.alertesMaxParJour(10), 144); assert.strictEqual(alertes.alertesMaxParJour(30), 48); assert.strictEqual(alertes.alertesMaxParJour(0), null); });

  console.log("Rappels");
  ok("canaux de rappel selon la fenetre et l'option", () => {
    assert.deepStrictEqual(alertes.canauxRappel(true, false), ["texte"]);
    assert.deepStrictEqual(alertes.canauxRappel(true, true), ["texte", "modele"]);
    assert.deepStrictEqual(alertes.canauxRappel(false, true), ["modele"]);
    assert.deepStrictEqual(alertes.canauxRappel(false, false), []);
  });

  console.log("Reglages");
  ok("marchand historique : alertes et rappels actifs, aucun regroupement", () => {
    const r = db.reglagesNotifDe({}, null);
    assert.strictEqual(r.alertesWhatsapp, true); assert.strictEqual(r.rappelsRdv, true); assert.strictEqual(r.intervalleEffectifMinutes, 0);
  });
  ok("nouveau marchand : options fermees, regroupement 10 par defaut", () => {
    const r = db.reglagesNotifDe({ reglagesNotif: db.REGLAGES_NOTIF_NOUVEAU }, null);
    assert.strictEqual(r.alertesWhatsapp, false); assert.strictEqual(r.rappelsRdv, false); assert.strictEqual(r.regroupementMinutes, 10); assert.strictEqual(r.intervalleEffectifMinutes, 10);
  });
  ok("plancher du super-administrateur : le marchand ne descend pas en dessous", () => {
    const r = db.reglagesNotifDe({ reglagesNotif: { alertesWhatsapp: true, regroupementMinutes: 0, regroupementMinimumMinutes: 15 } }, null);
    assert.strictEqual(r.intervalleEffectifMinutes, 15);
  });
  ok("plafond enseigne : moitie du delai minimum", () => {
    const r = db.reglagesNotifDe({ reglagesNotif: { alertesWhatsapp: true, regroupementMinutes: 30, regroupementMinimumMinutes: 0 } }, 15);
    assert.strictEqual(r.intervalleEffectifMinutes, 15); assert.strictEqual(r.plafondMinutes, 15);
  });
  ok("valeurs invalides ramenees aux choix permis", () => {
    const r = db.normaliserReglagesNotif({ alertesWhatsapp: "oui", regroupementMinutes: 7, regroupementMinimumMinutes: 99 });
    assert.strictEqual(r.alertesWhatsapp, false); assert.strictEqual(r.regroupementMinutes, 10); assert.strictEqual(r.regroupementMinimumMinutes, 0);
  });
  console.log(nb + " tests passes");
})().catch((err) => { console.error(err); process.exit(1); });
