"use strict";
// Etape 86 : couleur ET taille en UNE seule liste (moteur catalogue). Lancer : node tests_variante/test_variante_unique.js
const assert = require("assert");
const createCatalogEngine = require("../conversation");
const V = (c, t, s) => ({ couleur: c, taille: t, prix: 9000, stockReel: s, seuilAlerte: 1 });
const P = (id, nom, variantes) => ({ id, nom, categorie: "", photos: [], variantes });
(async () => {
  const envoyes = [];
  const eng = createCatalogEngine("t_var86", { nomMarchand: () => "Boutique Test", envoyer: async (d, t) => { envoyes.push([d, t]); }, notifierMarchand: async () => {} });
  await eng.init();
  eng.updateCatalog([
    P("tshirt", "Tee-shirt coton", [V("Blanc", "S", 5), V("Blanc", "M", 5), V("Blanc", "L", 5), V("Noir", "S", 5), V("Noir", "M", 5), V("Noir", "L", 5)]),
    P("sept", "Veste sept options", [V("Rouge", "S", 5), V("Rouge", "M", 5), V("Rouge", "L", 5), V("Bleu", "S", 5), V("Bleu", "M", 5), V("Bleu", "L", 5), V("Bleu", "XL", 5)]),
    P("huit", "Pantalon huit options", [V("Beige", "S", 5), V("Beige", "M", 5), V("Beige", "L", 5), V("Beige", "XL", 5), V("Gris", "S", 5), V("Gris", "M", 5), V("Gris", "L", 5), V("Gris", "XL", 5)]),
    P("polo", "Polo piqué", [V("Blanc", "S", 0), V("Blanc", "L", 2), V("Noir", "M", 3), V("Noir", "L", 0)]),
    P("une", "Polo une option", [V("Blanc", "S", 0), V("Blanc", "L", 2), V("Noir", "M", 0)]),
    P("casquette", "Casquette sport", [V("Rouge", "-", 5), V("Bleu", "-", 5)]),
    P("chaussette", "Chaussettes sport", [V("Blanc", "38", 0), V("Noir", "40", 0)]),
    P("sac", "Sac unique", [V("-", "-", 5)])
  ]);
  const say = (tel, t) => eng.handleMessage(tel, t);
  const etat = (tel) => eng.getEtatSession(tel);
  const nouveau = (tel, langue) => { say(tel, "Bonjour"); say(tel, langue || "fr"); };

  // 1. 6 variantes disponibles -> UNE liste (pendingChoice "variante"), meme avec un article « - » dans le catalogue (le tiret de « Tee-shirt »)
  let T = "237690000001"; nouveau(T);
  let r = say(T, "Tee-shirt coton");
  assert(/quelle option/.test(r) && /Blanc S/.test(r) && /Noir L/.test(r), r);
  assert.strictEqual(etat(T).pendingChoice.type, "variante"); assert.strictEqual(etat(T).pendingChoice.options.length, 6);
  r = say(T, "Noir M"); assert(/Noir M/.test(r) && /Combien/.test(r), r); assert.strictEqual(etat(T).stage, "awaiting_quantity");
  // 2. 7 variantes (maximum) -> liste unique ; 8 variantes -> parcours habituel (couleur puis taille)
  T = "237690000002"; nouveau(T); r = say(T, "Veste sept options"); assert(/quelle option/.test(r), r); assert.strictEqual(etat(T).pendingChoice.options.length, 7);
  T = "237690000003"; nouveau(T); r = say(T, "Pantalon huit options"); assert(/quelle couleur/.test(r), r); assert.strictEqual(etat(T).pendingChoice.type, "couleur");
  // 3. ruptures : seules les variantes disponibles sont proposees (2), une seule dispo ou aucune -> parcours habituel
  T = "237690000004"; nouveau(T); r = say(T, "Polo piqué"); assert(/Blanc L/.test(r) && /Noir M/.test(r) && !/Blanc S/.test(r) && !/Noir L/.test(r), r);
  T = "237690000005"; nouveau(T); r = say(T, "Polo une option"); assert(/quelle couleur/.test(r), r);
  T = "237690000006"; nouveau(T); r = say(T, "Chaussettes sport"); assert(/quelle couleur/.test(r), r);
  // 4. couleur seule, ou rien a choisir : inchange
  T = "237690000007"; nouveau(T); r = say(T, "Casquette sport"); assert(/quelle couleur/.test(r), r);
  T = "237690000008"; nouveau(T); r = say(T, "Sac unique"); assert(/Combien/.test(r), r);
  // 5. le client precise deja la couleur : une seule etape de taille ; reponse partielle apres la liste unique : etape suivante habituelle
  T = "237690000009"; nouveau(T); r = say(T, "Tee-shirt coton noir"); assert(/Quelle taille/.test(r), r);
  T = "237690000010"; nouveau(T); say(T, "Tee-shirt coton"); r = say(T, "blanc"); assert(/Quelle taille/.test(r), r); r = say(T, "M"); assert(/Blanc M/.test(r) && /Combien/.test(r), r);
  T = "237690000011"; nouveau(T); say(T, "Tee-shirt coton"); r = say(T, "L"); assert(/quelle couleur/.test(r), r);
  // 6. « autre chose » ramene au catalogue ; anglais
  T = "237690000012"; nouveau(T); say(T, "Tee-shirt coton"); r = say(T, "autre chose"); assert(/Quel article/.test(r), r);
  T = "237690000013"; nouveau(T, "en"); r = say(T, "Tee-shirt coton"); assert(/which option/.test(r) && /Available/.test(r), r); r = say(T, "Blanc L"); assert(/How many/.test(r), r);
  // 7. un tiret dans le message n'est jamais pris pour une couleur (article « - » dans le catalogue)
  T = "237690000014"; nouveau(T); r = say(T, "Tee-shirt coton"); assert(!/Combinaison|introuvable/.test(r), r);
  console.log("couleur + taille en une liste : OK");
})().catch((e) => { console.error("ECHEC", e); process.exit(1); });
