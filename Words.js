// The panel's words in English and Danish, and the Danish names of the places
// the models name in English. The forecast's own sentences are in
// PointSeries.summary and ChanceModel.parts (both take the same `lang`).
// Pure functions (no QML), unit-tested.

// A saved or asked-for language ("da", "Dansk"; anything else English) as a code.
function language(value) {
  return value === "Dansk" || value === "da" ? "da" : "en"
}

var TEXT = {
  en: {
    rainRadar: "Rain radar",
    denmark: "Denmark",
    peak: "peak",
    needsPython: "needs Python 3 to read the radar",
    radarOld: function(lead) { return "radar " + lead + " old" },
    dataAge: function(time, lead) { return "Radar from " + time + " · " + lead + " ago" },
    delayed: "DMI may be delayed; the nowcast runs from then",
    rainAtLocation: "Rain at a location",
    done: "Done",
    changePlace: "Change place",
    finding: "Finding your location…",
    intro: "Click the map in Denmark or pick a town to see the rain falling there, and what to expect over the next 90 minutes.",
    locating: "Locating…",
    useLocation: "Use location",
    noWttr: "Could not find your location (wttr.in did not answer). Pick a place instead.",
    outside: function(name) { return "Your location (" + (name || "unknown") + ") is outside Denmark. Pick a place instead." },
    townPlaceholder: "Danish town or place",
    noTown: "No Danish place by that name",
    lastKnown: "Showing last known data — ",
    how: "How does it work?",
    otherLanguage: "Dansk",
    light: "Light", heavy: "Heavy", extreme: "Extreme",
    edge: "Rain from beyond the map's edge: a guess (brighter = heavier)",
    now: "now",
    chanceOfRain: "chance of rain",
    chance: "chance",
    unit: "mm/h",
    pythonMissing: "Python 3 is needed to read DMI's radar scans, and was not found.",
    formatChanged: "DMI's radar files have changed format, and this version cannot read them.",
    noData: "No data available.",
    needTwo: "Need at least two recent radar frames to extrapolate — showing observed radar only.",
    cannotExtrapolate: "Could not read radar data for extrapolation — showing observed radar only.",
    noApi: "Could not reach DMI radar API."
  },
  da: {
    rainRadar: "Regnradar",
    denmark: "Danmark",
    peak: "maks.",
    needsPython: "kræver Python 3 for at læse radaren",
    radarOld: function(lead) { return "radar " + lead + " gammel" },
    dataAge: function(time, lead) { return "Radar fra " + time + " · for " + lead + " siden" },
    delayed: "DMI kan være forsinket; prognosen regner fra da",
    rainAtLocation: "Regn et bestemt sted",
    done: "Færdig",
    changePlace: "Skift sted",
    finding: "Finder din position…",
    intro: "Klik på kortet i Danmark eller vælg en by for at se regnen, der falder der, og hvad du kan forvente de næste 90 minutter.",
    locating: "Finder…",
    useLocation: "Brug position",
    noWttr: "Kunne ikke finde din position (wttr.in svarede ikke). Vælg et sted i stedet.",
    outside: function(name) { return "Din position (" + (name || "ukendt") + ") er uden for Danmark. Vælg et sted i stedet." },
    townPlaceholder: "By eller sted i Danmark",
    noTown: "Intet dansk sted med det navn",
    lastKnown: "Viser seneste kendte data — ",
    how: "Hvordan virker det?",
    otherLanguage: "English",
    light: "Let", heavy: "Kraftig", extreme: "Ekstrem",
    edge: "Regn uden for kortet: et skøn (lysere = kraftigere)",
    now: "nu",
    chanceOfRain: "chance for regn",
    chance: "chance",
    unit: "mm/t",
    pythonMissing: "Python 3 skal bruges til at læse DMI's radarbilleder og blev ikke fundet.",
    formatChanged: "DMI's radarfiler har skiftet format, og denne version kan ikke læse dem.",
    noData: "Ingen data.",
    needTwo: "Der skal mindst to nye radarbilleder til en prognose — viser kun målt radar.",
    cannotExtrapolate: "Kunne ikke læse radardata til prognosen — viser kun målt radar.",
    noApi: "Kunne ikke nå DMI's radar-API."
  }
}

// The word for `key` in `lang` (English if Danish lacks it); a word that
// takes values (dataAge, outside, radarOld) gets them as the further arguments.
function t(key, lang) {
  var table = TEXT[lang] || TEXT.en
  var w = key in table ? table[key] : TEXT.en[key]
  return typeof w === "function" ? w.apply(null, Array.prototype.slice.call(arguments, 2)) : w
}

// The models name some places in English (LocationModel's "Copenhagen",
// "near …", "Pinned location"; MapData's country labels): their Danish names.
var DANISH_NAMES = { Copenhagen: "København", Germany: "Tyskland", Sweden: "Sverige", Norway: "Norge", Poland: "Polen" }
function placeName(name, lang) {
  if (lang !== "da" || !name) return name
  if (name === "Pinned location") return "Valgt sted"
  var near = name.indexOf("near ") === 0
  var base = near ? name.slice(5) : name
  return (near ? "nær " : "") + (DANISH_NAMES[base] || base)
}

if (typeof module !== "undefined") module.exports = {
  TEXT: TEXT,
  language: language,
  t: t,
  placeName: placeName
}
