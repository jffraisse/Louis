/**
 * Vérification programmatique : la citation doit être contenue dans le
 * texte officiel. Le modèle ne décide plus seul du badge « vérifié ».
 */

export type QuoteVerdict = "VALIDATED" | "REJECTED" | "INTROUVABLE";

export function normalizeLegalText(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function verdictForQuote(
  officialText: string | null | undefined,
  claimedQuote: string | null | undefined
): QuoteVerdict {
  if (!officialText || !normalizeLegalText(officialText)) return "INTROUVABLE";
  if (!claimedQuote || !normalizeLegalText(claimedQuote)) return "REJECTED";

  const official = normalizeLegalText(officialText);
  const claimed = normalizeLegalText(claimedQuote);
  if (claimed.length < 24) return "REJECTED";
  if (official.includes(claimed)) return "VALIDATED";

  const core = claimed.slice(0, Math.min(160, claimed.length));
  if (core.length >= 40 && official.includes(core)) return "VALIDATED";
  return "REJECTED";
}

export function isArticleId(id: string): boolean {
  return /^LEGIARTI\d+$/i.test(id.trim());
}

export function isOverbroadTextId(id: string): boolean {
  return /^LEGITEXT\d+$/i.test(id.trim());
}
