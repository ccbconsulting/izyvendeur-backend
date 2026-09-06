// IzyVendeur - Catalogue de services de depart pour un marchand de type "service" (prise de rendez-vous).
// Sert de exemple/point de depart (secteur beaute/sante) - editable ensuite depuis l'interface admin,
// exactement comme SEED_CATALOG pour un marchand "catalogue" (voir catalog.js).

const SEED_SERVICES = [
  { id: "s1", nom: "Coupe femme", dureeMinutes: 45, prix: 8000 },
  { id: "s2", nom: "Brushing", dureeMinutes: 30, prix: 5000 },
  { id: "s3", nom: "Coloration", dureeMinutes: 90, prix: 20000 },
  { id: "s4", nom: "Manucure", dureeMinutes: 45, prix: 6000 },
  { id: "s5", nom: "Soin du visage", dureeMinutes: 60, prix: 15000 }
];

// Mots-cles supplementaires pour aider la reconnaissance (au-dela du simple nom du service).
const SERVICE_KEYWORDS = {
  s1: ["coupe", "cheveux"],
  s2: ["brushing", "brush"],
  s3: ["coloration", "couleur", "teinture"],
  s4: ["manucure", "ongles", "manicure"],
  s5: ["soin", "visage", "facial"]
};

// Horaires d'ouverture par defaut : lundi-samedi 8h-18h, dimanche ferme. Editable depuis l'interface admin.
const DEFAULT_HORAIRES = {
  dimanche: { ouvert: false, debut: "08:00", fin: "18:00" },
  lundi: { ouvert: true, debut: "08:00", fin: "18:00" },
  mardi: { ouvert: true, debut: "08:00", fin: "18:00" },
  mercredi: { ouvert: true, debut: "08:00", fin: "18:00" },
  jeudi: { ouvert: true, debut: "08:00", fin: "18:00" },
  vendredi: { ouvert: true, debut: "08:00", fin: "18:00" },
  samedi: { ouvert: true, debut: "08:00", fin: "18:00" }
};

const DEFAULT_DUREE_CRENEAU_MINUTES = 30;

const DEFAULT_AUTO_CONFIRM_MESSAGE =
  "Merci beaucoup, votre rendez-vous est confirmé ! 🙏\n\n" +
  "Merci d'arriver quelques minutes en avance. Besoin de reporter ou d'annuler ? Écrivez-nous ici même, on reste disponibles.";

module.exports = {
  SEED_SERVICES,
  SERVICE_KEYWORDS,
  DEFAULT_HORAIRES,
  DEFAULT_DUREE_CRENEAU_MINUTES,
  DEFAULT_AUTO_CONFIRM_MESSAGE
};
