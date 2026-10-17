/** Filet si un intermédiaire finit sans prose (ex. budget d'outils épuisé). */
export function ensureIntermediateText(
  role: string,
  label: string,
  value: string
): string {
  if (value.trim().length > 0) return value;
  if (role === "citator") {
    return [
      "## Vérification des citations",
      "",
      "Aucune citation vérifiée : l'agent a terminé sans texte (souvent après des appels d'outils).",
      "",
      "## Verdict",
      "RÉVISION NÉCESSAIRE",
    ].join("\n");
  }
  return `_(${label} : sortie vide)_`;
}
