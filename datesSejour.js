// IzyVendeur - Lecture des dates de sejour ecrites librement par un client (Etape 65, type « hebergement »).
//
// Les dates d'un sejour sont des JOURS CALENDAIRES (« AAAA-MM-JJ »), jamais des instants : une nuit appartient
// au jour ou elle commence, et le fuseau du marchand n'intervient que pour savoir quel jour on est aujourd'hui.
// Ce module est pur (aucune dependance, aucun etat) : `lireDatesSejour(texte, aujourdhui)` renvoie ce qu'il a
// compris, sans jamais deviner ce que le client n'a pas dit.
//
//   lireDatesSejour("du 12 au 15 novembre", { annee: 2026, mois: 10, jour: 19 })
//     -> { arrivee: "2026-11-12", depart: "2026-11-15", nuits: 3 }
//   lireDatesSejour("vendredi pour 2 nuits", ...)  -> { arrivee, depart, nuits: 2 }
//   lireDatesSejour("3 nuits", ...)                 -> { nuits: 3 }            (il manque l'arrivee)
//   lireDatesSejour("le 12 novembre", ...)          -> { arrivee: "2026-11-12" } (il manque le depart / les nuits)
//
// `aujourdhui` : { annee, mois (1-12), jour } dans le fuseau du marchand (voir shared.partiesFuseau).

const MOIS = {
  janvier: 1, janv: 1, jan: 1, january: 1,
  fevrier: 2, fevr: 2, fev: 2, feb: 2, february: 2,
  mars: 3, mar: 3, march: 3,
  avril: 4, avr: 4, apr: 4, april: 4,
  mai: 5, may: 5,
  juin: 6, jun: 6, june: 6,
  juillet: 7, juil: 7, jul: 7, july: 7,
  aout: 8, aou: 8, aug: 8, august: 8,
  septembre: 9, sept: 9, sep: 9, september: 9,
  octobre: 10, oct: 10, october: 10,
  novembre: 11, nov: 11, november: 11,
  decembre: 12, dec: 12, december: 12
};
const JOURS_SEMAINE = {
  dimanche: 0, dim: 0, sunday: 0, sun: 0,
  lundi: 1, lun: 1, monday: 1, mon: 1,
  mardi: 2, tuesday: 2, tue: 2, tues: 2,
  mercredi: 3, mer: 3, wednesday: 3, wed: 3,
  jeudi: 4, jeu: 4, thursday: 4, thu: 4, thur: 4, thurs: 4,
  vendredi: 5, ven: 5, friday: 5, fri: 5,
  samedi: 6, sam: 6, saturday: 6, sat: 6
};
const NOMBRES = {
  un: 1, une: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5,
  six: 6, sept: 7, seven: 7, huit: 8, eight: 8, neuf: 9, nine: 9, dix: 10, ten: 10
};

function normaliser(texte) {
  return String(texte == null ? "" : texte)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const pad = (n) => (n < 10 ? "0" : "") + n;
const iso = (a, m, j) => a + "-" + pad(m) + "-" + pad(j);

function joursDansMois(annee, mois) { return new Date(Date.UTC(annee, mois, 0)).getUTCDate(); }
function dateValide(annee, mois, jour) {
  return mois >= 1 && mois <= 12 && jour >= 1 && jour <= joursDansMois(annee, mois);
}

// Ajoute n jours a une date « AAAA-MM-JJ ».
function ajouterJours(dateIso, n) {
  const p = dateIso.split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// Nombre de nuits entre deux dates « AAAA-MM-JJ » (depart exclu).
function nuitsEntre(arrivee, depart) {
  const a = arrivee.split("-").map(Number), d = depart.split("-").map(Number);
  return Math.round((Date.UTC(d[0], d[1] - 1, d[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

function jourSemaineDe(dateIso) {
  const p = dateIso.split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

function comparer(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// Prochaine occurrence (aujourd'hui compris) d'un jour de mois donne, avec ou sans mois.
function resoudreJourMois(jour, mois, annee, aujourdhui) {
  const auj = iso(aujourdhui.annee, aujourdhui.mois, aujourdhui.jour);
  if (annee) {
    if (!dateValide(annee, mois, jour)) return null;
    return iso(annee, mois, jour);
  }
  if (mois) {
    let a = aujourdhui.annee;
    if (!dateValide(a, mois, jour)) {
      // 29 fevrier : on cherche la prochaine annee bissextile qui convient
      for (let k = 0; k < 5; k++) { a++; if (dateValide(a, mois, jour)) break; }
      if (!dateValide(a, mois, jour)) return null;
      return iso(a, mois, jour);
    }
    if (comparer(iso(a, mois, jour), auj) < 0) { a++; if (!dateValide(a, mois, jour)) return null; }
    return iso(a, mois, jour);
  }
  // jour seul : mois en cours si le jour n'est pas passe, sinon le suivant (en sautant les mois trop courts)
  let a = aujourdhui.annee, m = aujourdhui.mois;
  for (let k = 0; k < 14; k++) {
    if (dateValide(a, m, jour) && comparer(iso(a, m, jour), auj) >= 0) return iso(a, m, jour);
    m++; if (m > 12) { m = 1; a++; }
  }
  return null;
}

function prochainJourSemaine(cible, aujourdhui, ensuite) {
  const auj = iso(aujourdhui.annee, aujourdhui.mois, aujourdhui.jour);
  const actuel = jourSemaineDe(auj);
  let delta = (cible - actuel + 7) % 7;
  if (ensuite && delta === 0) delta = 7; // « vendredi prochain » dit un vendredi : la semaine suivante
  return ajouterJours(auj, delta);
}

const SOURCE_MOIS = Object.keys(MOIS).sort((a, b) => b.length - a.length).join("|");
const SOURCE_JOURS = Object.keys(JOURS_SEMAINE).sort((a, b) => b.length - a.length).join("|");

// Lit toutes les mentions de DATE du texte, dans l'ordre d'apparition. Chaque mention : { pos, fin, jour?, mois?,
// annee?, iso? }. Les mentions incompletes (jour sans mois) sont completees apres coup (voir completer()).
function trouverMentions(t, aujourdhui) {
  const mentions = [];
  const pris = []; // intervalles deja consommes pour ne jamais compter deux fois le meme texte
  const libre = (d, f) => !pris.some((p) => d < p[1] && f > p[0]);
  const ajouter = (m) => { mentions.push(m); pris.push([m.pos, m.fin]); };

  let r;
  // AAAA-MM-JJ
  const reIso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;
  while ((r = reIso.exec(t))) {
    if (libre(r.index, r.index + r[0].length) && dateValide(+r[1], +r[2], +r[3])) ajouter({ pos: r.index, fin: r.index + r[0].length, jour: +r[3], mois: +r[2], annee: +r[1] });
  }
  // plage « 12-15 novembre » / « 12 - 15 nov » (avant la lecture JJ-MM, sinon prise pour une date numerique)
  const rePlage = new RegExp("\\b(\\d{1,2})\\s*[-\u2013]\\s*(\\d{1,2})\\s*(?:de\\s+|of\\s+)?(" + SOURCE_MOIS + ")\\b\\.?(?:\\s+(20\\d{2}))?", "g");
  while ((r = rePlage.exec(t))) {
    if (!libre(r.index, r.index + r[0].length)) continue;
    const j1 = +r[1], j2 = +r[2];
    if (j1 < 1 || j1 > 31 || j2 < 1 || j2 > 31) continue;
    const mois = MOIS[r[3]], annee = r[4] ? +r[4] : null;
    const finPremier = r.index + r[1].length;
    ajouter({ pos: r.index, fin: finPremier, jour: j1, mois, annee });
    ajouter({ pos: finPremier, fin: r.index + r[0].length, jour: j2, mois, annee });
  }
  // JJ/MM[/AAAA], JJ-MM, JJ.MM
  const reNum = /\b(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s*[\/.\-]\s*(\d{2}|\d{4}))?\b/g;
  while ((r = reNum.exec(t))) {
    if (!libre(r.index, r.index + r[0].length)) continue;
    const jour = +r[1], mois = +r[2];
    if (jour < 1 || jour > 31 || mois < 1 || mois > 12) continue;
    let annee = r[3] ? +r[3] : null;
    if (annee !== null && annee < 100) annee += 2000;
    ajouter({ pos: r.index, fin: r.index + r[0].length, jour, mois, annee });
  }
  // « 12 novembre [2026] », « 12th of november », « le 12 nov »
  const reJourMois = new RegExp("\\b(\\d{1,2})(?:er|eme|e|st|nd|rd|th)?\\s*(?:de\\s+|of\\s+)?(" + SOURCE_MOIS + ")\\b\\.?(?:\\s+(20\\d{2}))?", "g");
  while ((r = reJourMois.exec(t))) {
    if (!libre(r.index, r.index + r[0].length)) continue;
    const jour = +r[1];
    if (jour < 1 || jour > 31) continue;
    ajouter({ pos: r.index, fin: r.index + r[0].length, jour, mois: MOIS[r[2]], annee: r[3] ? +r[3] : null });
  }
  // « november 12 [2026] »
  const reMoisJour = new RegExp("\\b(" + SOURCE_MOIS + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(20\\d{2}))?", "g");
  while ((r = reMoisJour.exec(t))) {
    if (!libre(r.index, r.index + r[0].length)) continue;
    const jour = +r[2];
    if (jour < 1 || jour > 31) continue;
    ajouter({ pos: r.index, fin: r.index + r[0].length, jour, mois: MOIS[r[1]], annee: r[3] ? +r[3] : null });
  }
  // aujourd'hui / demain / apres-demain (et EN)
  const reRel = /\b(apres[\s-]?demain|day after tomorrow|aujourd'?hui|today|ce soir|tonight|demain|tomorrow)\b/g;
  while ((r = reRel.exec(t))) {
    if (!libre(r.index, r.index + r[0].length)) continue;
    const auj = iso(aujourdhui.annee, aujourdhui.mois, aujourdhui.jour);
    const mot = r[1];
    const delta = /apres|after/.test(mot) ? 2 : /demain|tomorrow/.test(mot) ? 1 : 0;
    const d = ajouterJours(auj, delta);
    const p = d.split("-").map(Number);
    ajouter({ pos: r.index, fin: r.index + r[0].length, jour: p[2], mois: p[1], annee: p[0], iso: d });
  }
  // jour de la semaine (« vendredi », « ce vendredi », « vendredi prochain », « next friday »)
  const reSem = new RegExp("\\b(?:(next)\\s+)?(" + SOURCE_JOURS + ")\\b(\\s+prochain)?", "g");
  while ((r = reSem.exec(t))) {
    if (!libre(r.index, r.index + r[0].length)) continue;
    const d = prochainJourSemaine(JOURS_SEMAINE[r[2]], aujourdhui, !!(r[1] || r[3]));
    const p = d.split("-").map(Number);
    ajouter({ pos: r.index, fin: r.index + r[0].length, jour: p[2], mois: p[1], annee: p[0], iso: d, cibleSemaine: JOURS_SEMAINE[r[2]] });
  }
  // jour seul : « le 12 », « du 12 au 15 », « the 12th » - uniquement apres « le/du/au/from/to/the/on » ou dans une plage
  const reJourSeul = /\b(?:le|du|au|from|to|the|on|jusqu'?au|until)\s+(\d{1,2})(?:er|eme|e|st|nd|rd|th)?\b(?!\s*(?:nuit|night|personne|people|pers|adulte|adult|h\b|heure|:|\/|-|\.))/g;
  while ((r = reJourSeul.exec(t))) {
    const debutNombre = r.index + r[0].length - r[1].length - (/(er|eme|e|st|nd|rd|th)$/.test(r[0]) ? (r[0].match(/(er|eme|e|st|nd|rd|th)$/)[0].length) : 0);
    if (!libre(debutNombre, r.index + r[0].length)) continue;
    const jour = +r[1];
    if (jour < 1 || jour > 31) continue;
    ajouter({ pos: debutNombre, fin: r.index + r[0].length, jour, mois: null, annee: null });
  }
  mentions.sort((a, b) => a.pos - b.pos);
  return mentions;
}

// Complete les mentions sans mois : elles heritent du mois de la mention suivante (« du 28 au 3 decembre » -> 28 novembre),
// sinon de la prochaine occurrence a partir d'aujourd'hui.
function completer(mentions, aujourdhui) {
  for (let i = mentions.length - 1; i >= 0; i--) {
    const m = mentions[i];
    if (m.iso) continue;
    if (m.mois) {
      m.iso = resoudreJourMois(m.jour, m.mois, m.annee, aujourdhui);
      continue;
    }
    const suivante = mentions[i + 1];
    if (suivante && suivante.iso) {
      const p = suivante.iso.split("-").map(Number);
      let a = p[0], mo = p[1];
      if (m.jour > p[2]) { mo--; if (mo < 1) { mo = 12; a--; } }
      m.iso = dateValide(a, mo, m.jour) ? iso(a, mo, m.jour) : null;
    } else {
      m.iso = resoudreJourMois(m.jour, null, null, aujourdhui);
    }
  }
  return mentions;
}

function lireNuits(t) {
  let r = t.match(/\b(\d{1,2})\s*(?:nuit|nuits|night|nights)\b/);
  if (r) return +r[1];
  r = t.match(new RegExp("\\b(" + Object.keys(NOMBRES).join("|") + ")\\s+(?:nuit|nuits|night|nights)\\b"));
  if (r) return NOMBRES[r[1]];
  if (/\b(?:une|1|one|a)\s+semaine\b|\b(?:one|a|1)\s+week\b(?!-?end)/.test(t)) return 7;
  if (/\b(\d)\s+semaines?\b/.test(t)) return +t.match(/\b(\d)\s+semaines?\b/)[1] * 7;
  if (/\b(\d)\s+weeks?\b/.test(t)) return +t.match(/\b(\d)\s+weeks?\b/)[1] * 7;
  return null;
}

// Point d'entree. Ne devine jamais une arrivee ou un depart que le client n'a pas donne.
function lireDatesSejour(texte, aujourdhui) {
  const t = normaliser(texte);
  const resultat = {};
  if (!t) return resultat;
  const nuits = lireNuits(t);
  let mentions = completer(trouverMentions(t, aujourdhui), aujourdhui).filter((m) => m.iso);

  // « week-end » sans autre date : le prochain vendredi, 2 nuits (le client peut preciser)
  if (!mentions.length && /\bweek[\s-]?end\b/.test(t)) {
    const arrivee = prochainJourSemaine(5, aujourdhui, false);
    resultat.arrivee = arrivee;
    resultat.nuits = nuits || 2;
    resultat.depart = ajouterJours(arrivee, resultat.nuits);
    resultat.weekend = true;
    return resultat;
  }

  if (mentions.length >= 2) {
    // Une plage (« du 12 au 15 ») : on garde les deux premieres mentions.
    let a = mentions[0].iso, d = mentions[1].iso;
    // « du vendredi au lundi » : le second jour de la semaine est celui qui SUIT l'arrivee, pas le prochain a partir d'aujourd'hui
    if (mentions[1].cibleSemaine !== undefined && comparer(d, a) <= 0) {
      d = ajouterJours(a, ((mentions[1].cibleSemaine - jourSemaineDe(a) + 7) % 7) || 7);
    }
    if (comparer(d, a) < 0) {
      // « du 28 au 3 » sans mois explicite sur la seconde : on avance la seconde d'un mois
      const p = d.split("-").map(Number);
      let aa = p[0], mm = p[1] + 1; if (mm > 12) { mm = 1; aa++; }
      const corrige = dateValide(aa, mm, p[2]) ? iso(aa, mm, p[2]) : null;
      d = corrige && comparer(corrige, a) > 0 ? corrige : d;
    }
    resultat.arrivee = a;
    if (comparer(d, a) > 0) { resultat.depart = d; resultat.nuits = nuitsEntre(a, d); }
    else if (nuits) { resultat.nuits = nuits; resultat.depart = ajouterJours(a, nuits); }
    return resultat;
  }
  if (mentions.length === 1) {
    resultat.arrivee = mentions[0].iso;
    if (nuits) { resultat.nuits = nuits; resultat.depart = ajouterJours(resultat.arrivee, nuits); }
    return resultat;
  }
  if (nuits) resultat.nuits = nuits;
  return resultat;
}

// Lit un nombre de personnes (« 2 », « 2 personnes », « deux adultes », « 3 people »). null si rien de clair.
function lirePersonnes(texte) {
  const t = normaliser(texte);
  let r = t.match(/\b(\d{1,2})\s*(?:personne|personnes|pers|adulte|adultes|adults?|people|persons?|guests?|pax)?\b/);
  if (r && /^\s*\d{1,2}\s*(?:personnes?|pers|adultes?|adults?|people|persons?|guests?|pax)?\s*$/.test(t)) return +r[1];
  r = t.match(/\b(\d{1,2})\s*(?:personne|personnes|pers|adulte|adultes|adults?|people|persons?|guests?|pax)\b/);
  if (r) return +r[1];
  r = t.match(new RegExp("\\b(" + Object.keys(NOMBRES).join("|") + ")\\s*(?:personne|personnes|adulte|adultes|adults?|people|persons?|guests?)?\\s*$"));
  if (r) return NOMBRES[r[1]];
  r = t.match(new RegExp("\\b(" + Object.keys(NOMBRES).join("|") + ")\\s+(?:personne|personnes|adulte|adultes|adults?|people|persons?|guests?)\\b"));
  if (r) return NOMBRES[r[1]];
  if (/^\s*(?:seul|seule|alone|just me|moi seul|only me)\s*$/.test(t)) return 1;
  if (/\b(?:en couple|a deux|for two|couple)\b/.test(t)) return 2;
  return null;
}

module.exports = { lireDatesSejour, lirePersonnes, ajouterJours, nuitsEntre, jourSemaineDe, dateValide, iso, normaliser, joursDansMois, comparer, DATES_MOIS: MOIS };
