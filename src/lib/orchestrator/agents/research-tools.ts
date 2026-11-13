/**
 * Politique hard du rôle Recherche : Judilibre disponible même si le Board
 * a une allowlist obsolète, et verify_quote réservé au Citateur.
 */

export const RESEARCH_FORBIDDEN_TOOLS = ["legifrance_verify_quote"] as const;

export const RESEARCH_REQUIRED_TOOLS = [
  "judilibre_search",
  "judilibre_decision",
] as const;

/** Fusionne l'allowlist Board/défaut : retire verify_quote, injecte Judilibre. */
export function resolveResearchToolAllowlist(
  allowlist: string[] | null
): string[] | null {
  if (allowlist === null) return null;
  const deny = new Set<string>(RESEARCH_FORBIDDEN_TOOLS);
  const next = allowlist.filter((name) => !deny.has(name));
  for (const required of RESEARCH_REQUIRED_TOOLS) {
    if (!next.includes(required)) next.push(required);
  }
  return next;
}

type StepLike = {
  toolCalls?: ReadonlyArray<{ toolName: string }>;
};

/**
 * Après un noyau d'articles (ou step ≥ 6), force judilibre_search puis
 * judilibre_decision avant la conclusion textuelle.
 */
export function researchJudilibreToolChoice(args: {
  stepNumber: number;
  maxSteps: number;
  steps: readonly StepLike[];
  availableTools: ReadonlySet<string>;
}): { type: "tool"; toolName: "judilibre_search" | "judilibre_decision" } | undefined {
  if (args.stepNumber >= args.maxSteps - 1) return undefined;
  if (
    !args.availableTools.has("judilibre_search") ||
    !args.availableTools.has("judilibre_decision")
  ) {
    return undefined;
  }

  const called: string[] = [];
  for (const step of args.steps) {
    for (const call of step.toolCalls ?? []) called.push(call.toolName);
  }

  const hasSearch = called.includes("judilibre_search");
  const hasDecision = called.includes("judilibre_decision");
  const getArticleCount = called.filter(
    (name) => name === "legifrance_get_article"
  ).length;

  if (!hasSearch && (getArticleCount >= 4 || args.stepNumber >= 6)) {
    return { type: "tool", toolName: "judilibre_search" };
  }
  if (hasSearch && !hasDecision) {
    return { type: "tool", toolName: "judilibre_decision" };
  }
  return undefined;
}
