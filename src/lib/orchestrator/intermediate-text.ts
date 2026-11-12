/**
 * Détecte un appel d'outil écrit en prose/XML au lieu d'être exécuté par le
 * runtime (bug fréquent avec certains modèles locaux ou routes OpenRouter
 * sans function calling natif).
 */
export function looksLikeLeakedToolCall(text: string): boolean {
  return (
    /<tool_call\b/i.test(text) ||
    /<\/tool_call>/i.test(text) ||
    /<function\s*=/i.test(text)
  );
}

/** Filet si un intermédiaire finit sans prose utile. */
export function ensureIntermediateText(
  role: string,
  label: string,
  value: string
): string {
  const trimmed = value.trim();
  if (trimmed.length > 0 && !looksLikeLeakedToolCall(trimmed)) return value;

  if (looksLikeLeakedToolCall(trimmed)) {
    return [
      `## ${label} — appel d'outil non exécuté`,
      "",
      "L'agent a écrit un appel d'outil en texte (balises tool_call / function=) au lieu de l'exécuter via l'API.",
      "Conséquence : aucune vérification Légifrance n'a eu lieu.",
      "",
      "À vérifier dans le Board :",
      "- le modèle de cet agent supporte le *function calling* natif (ex. Mistral Large, GPT, Claude) ;",
      "- le connecteur PISTE est actif (sinon `legifrance_*` n'est pas proposé) ;",
      "- les outils attendus sont bien cochés sur l'agent.",
      "",
      role === "citator" ? "## Verdict\nRÉVISION NÉCESSAIRE" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

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
