// IzyVendeur - Catalogue de depart (identique a la demo du prototype "Boutique Adele Mode")
// Sert de exemple/point de depart pour un marchand. Plus tard, chaque marchand aura son propre catalogue
// (charge depuis une vraie base de donnees, ou importe via CSV comme dans le prototype).

const SEED_CATALOG = [
  { id: "p1", nom: "Robe wax imprimée", cat: "Robes", variantes: [
    { couleur: "Rouge", taille: "S", prix: 15000, stockReel: 4, seuilAlerte: 2 },
    { couleur: "Rouge", taille: "M", prix: 15000, stockReel: 0, seuilAlerte: 2 },
    { couleur: "Rouge", taille: "L", prix: 15000, stockReel: 2, seuilAlerte: 2 },
    { couleur: "Bleu", taille: "M", prix: 15000, stockReel: 6, seuilAlerte: 2 },
    { couleur: "Vert", taille: "M", prix: 15000, stockReel: 3, seuilAlerte: 2 }
  ]},
  { id: "p2", nom: "Robe soirée dentelle", cat: "Robes", variantes: [
    { couleur: "Noir", taille: "M", prix: 28000, stockReel: 5, seuilAlerte: 1 },
    { couleur: "Noir", taille: "L", prix: 28000, stockReel: 1, seuilAlerte: 1 },
    { couleur: "Bordeaux", taille: "M", prix: 28000, stockReel: 0, seuilAlerte: 1 }
  ]},
  { id: "p3", nom: "Ensemble pagne 2 pièces", cat: "Ensembles", variantes: [
    { couleur: "Jaune", taille: "M", prix: 20000, stockReel: 3, seuilAlerte: 1 },
    { couleur: "Orange", taille: "L", prix: 20000, stockReel: 2, seuilAlerte: 1 }
  ]},
  { id: "p4", nom: "Chemise homme popeline", cat: "Homme", variantes: [
    { couleur: "Blanc", taille: "M", prix: 12000, stockReel: 8, seuilAlerte: 2 },
    { couleur: "Bleu ciel", taille: "L", prix: 12000, stockReel: 5, seuilAlerte: 2 }
  ]},
  { id: "p5", nom: "Sac à main cuir façon croco", cat: "Accessoires", variantes: [
    { couleur: "Noir", taille: "Unique", prix: 18000, stockReel: 6, seuilAlerte: 1 },
    { couleur: "Camel", taille: "Unique", prix: 18000, stockReel: 0, seuilAlerte: 1 }
  ]},
  { id: "p6", nom: "Baskets femme tendance", cat: "Chaussures", variantes: [
    { couleur: "Blanc", taille: "38", prix: 25000, stockReel: 3, seuilAlerte: 2 },
    { couleur: "Blanc", taille: "39", prix: 25000, stockReel: 0, seuilAlerte: 2 },
    { couleur: "Noir", taille: "37", prix: 25000, stockReel: 4, seuilAlerte: 2 }
  ]}
];

// Mots-cles supplementaires pour aider la reconnaissance (au-dela du simple nom de l'article).
const PROD_KEYWORDS = {
  p2: ["dentelle", "soirée", "soiree"],
  p3: ["pagne", "ensemble"],
  p4: ["chemise"],
  p5: ["sac"],
  p6: ["basket", "baskets", "sneakers"],
  p1: ["robe"]
};

const DEFAULT_AUTO_CONFIRM_MESSAGE =
  "Merci beaucoup pour votre commande ! 🙏 Elle est confirmée.\n\n" +
  "Conditions : paiement à la livraison ou par Mobile Money, articles vérifiés avant expédition, " +
  "livraison sous 24 à 72h selon votre zone. Un souci avec votre commande ? Écrivez-nous ici même, on reste disponibles.";

// Repli UNIQUEMENT quand le client est en session anglaise ET que le marchand n'a pas renseigne son propre
// message de confirmation en anglais (voir Parametres > "Message de confirmation (English)" dans /admin) -
// evite de montrer le message francais du marchand a un client qui a choisi English.
const DEFAULT_AUTO_CONFIRM_MESSAGE_EN =
  "Thank you so much for your order! 🙏 It's confirmed.\n\n" +
  "Terms: payment on delivery or by Mobile Money, items checked before shipping, " +
  "delivery within 24 to 72h depending on your area. Any issue with your order? Just write to us here, we're available.";

module.exports = { SEED_CATALOG, PROD_KEYWORDS, DEFAULT_AUTO_CONFIRM_MESSAGE, DEFAULT_AUTO_CONFIRM_MESSAGE_EN };
