import { canonicalArticleNum } from "../connectors/legifrance-map";

/**
 * Barrière fail-closed. Seules les lignes machine du citateur comptent :
 * @@CITE status=VALIDATED id=LEGIARTI… num=1104 version=APPLICABLE@@
 * Le prose « VALIDATED » ne suffit pas. Le modèle ne décide pas du badge.
 */

export type CitationGate = {
  active: boolean;
  validatedNums: Set<string>;
  validatedIds: Set<string>;
};

export const REDACTED = "« référence retirée — non VALIDATED »";

const CITE_MARKER =
  /@@CITE\s+status=(VALIDATED|REJECTED|INTROUVABLE)\s+id=(\S+)\s+num=(\S+)\s+version=(EN_VIGUEUR|APPLICABLE|INDISPONIBLE)\s*@@/gi;

/** Tiret ASCII ou typographique (souvent collé par le modèle). */
const H = "[-\\u2010-\\u2015]";

const ARTICLE_SEQ = new RegExp(
  `(?:articles?|art\\.?)\\s+((?:[LRD]\\.?\\s*)?\\d{1,4}(?:${H}\\d+){0,3}(?:\\s*(?:,|et|ou)\\s*(?:[LRD]\\.?\\s*)?\\d{1,4}(?:${H}\\d+){0,3})*)`,
  "gi"
);
const BARE_LNUM = new RegExp(
  `\\b([LRD]\\.\\s*\\d{1,4}(?:${H}\\d+){0,3})\\b`,
  "gi"
);
/** Numéros nus de code (1109, 1231-1). Pas les 1–2 chiffres (trop ambigus). */
const BARE_ARTICLE = new RegExp(`\\b(\\d{3,4}(?:${H}\\d{1,3}){0,3})\\b`, "gi");
/** Pourvoi du type 17-14.125, que l'allowlist d'articles ne couvre jamais. */
const POURVOI = new RegExp(`(?:\\bn[°ºo]\\s*)?\\b\\d{2}${H}\\d{2}\\.\\d{3}\\b`, "gi");
const MONTHS =
  "janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre";
const DATE = `\\d{1,2}(?:er)?\\s+(?:${MONTHS})\\s+\\d{4}`;
/** Décision citée par sa juridiction et sa date (« Cass. civ. 1re, 12 octobre 2018 »). */
const DECISION = new RegExp(
  `\\b(?:Cass\\.|Cour de cassation|Conseil d'[ÉE]tat|CE\\b)[^\\n;|]{0,30}?${DATE}`,
  "gi"
);
const DECISION_ID = /^(?:JURITEXT|CETATEXT|ECLI:)/;
const AUTHORITY_ID = /LEGIARTI\d+|JURITEXT\d+|CETATEXT\d+|ECLI:FR:[A-Z0-9:.]*[A-Z0-9]/gi;
const CONFIDENT = /\bCertaine?\b(?!s)/g;

const CITATOR_SOURCES = new Set(["research", "legifrance"]);

/** Le citateur ne voit que la recherche, pas le raisonnement du rédacteur. */
export function priorForCitator<T extends { role: string }>(
  role: string,
  outputs: T[]
): T[] {
  if (role !== "citator") return outputs;
  return outputs.filter((output) => CITATOR_SOURCES.has(output.role));
}

function isYear(num: string): boolean {
  return /^\d{4}$/.test(num) && Number(num) >= 1900 && Number(num) <= 2100;
}

function rememberNum(set: Set<string>, raw: string): void {
  if (raw === "-" || raw === "—") return;
  const num = canonicalArticleNum(raw);
  if (!num || isYear(num)) return;
  set.add(num);
}

export function buildCitationGate(
  outputs: Array<{ role: string; output: string }>
): CitationGate {
  const citator = outputs.filter((output) => output.role === "citator");
  if (citator.length === 0) {
    return { active: false, validatedNums: new Set(), validatedIds: new Set() };
  }

  const validatedNums = new Set<string>();
  const validatedIds = new Set<string>();
  for (const output of citator) {
    for (const marker of output.output.matchAll(new RegExp(CITE_MARKER.source, "gi"))) {
      const status = (marker[1] ?? "").toUpperCase();
      const version = (marker[4] ?? "").toUpperCase();
      if (status !== "VALIDATED" || version === "INDISPONIBLE") continue;
      const id = (marker[2] ?? "").toUpperCase();
      if (id && id !== "-") validatedIds.add(id);
      rememberNum(validatedNums, marker[3] ?? "");
    }
  }

  return { active: true, validatedNums, validatedIds };
}

function numAllowed(raw: string, gate: CitationGate): boolean {
  const num = canonicalArticleNum(raw);
  return Boolean(num) && gate.validatedNums.has(num);
}

function isSep(part: string): boolean {
  return /^\s*(?:,|et|ou)\s*$/i.test(part);
}

function redactSequence(sequence: string, gate: CitationGate): {
  text: string;
  anyAllowed: boolean;
  anyBlocked: boolean;
} {
  let anyAllowed = false;
  let anyBlocked = false;
  const text = sequence
    .split(/(\s*(?:,|et|ou)\s*)/i)
    .map((part) => {
      if (isSep(part)) return part;
      if (numAllowed(part, gate)) {
        anyAllowed = true;
        return part;
      }
      anyBlocked = true;
      return REDACTED;
    })
    .join("");
  return { text, anyAllowed, anyBlocked };
}

/** Un numéro nu qui ressemble à une loi (2004-575) ou une unité, pas un article. */
function skipBareArticle(match: string, line: string, index: number): boolean {
  const canon = canonicalArticleNum(match);
  if (!canon || isYear(canon)) return true;
  if (/^(19|20)\d{2}-\d{2,5}$/.test(canon)) return true;
  const before = line.slice(Math.max(0, index - 16), index);
  if (/n[°ºo]\s*$/i.test(before)) return true;
  if (new RegExp(`\\d{4}${H}$`).test(before)) return true;
  if (/\b(?:loi|décret|decret|ordonnance)\s*$/i.test(before)) return true;
  const after = line.slice(index + match.length, index + match.length + 16);
  if (/^\.\d/.test(after)) return true;
  if (/^\s*(?:mois|jours?|heures?|ans?|h\b|%|€)/i.test(after)) return true;
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REDACTED_RUN = new RegExp(
  `${escapeRegExp(REDACTED)}(?:\\s*(?:,|et|ou|à)\\s*${escapeRegExp(REDACTED)})+`,
  "g"
);

/** Décret, arrêté ou ordonnance cité par numéro ou par date. */
const REGULATORY_TEXT = new RegExp(
  `\\b(?:d[ée]cret|arr[êe]t[ée]|ordonnance)\\s+(?:n[°ºo]\\s*\\d{2,4}(?:${H}\\d+)+(?:\\s+du\\s+${DATE})?|du\\s+${DATE})`,
  "gi"
);

function lineHasValidatedId(
  line: string,
  gate: CitationGate,
  kind?: RegExp
): boolean {
  const upper = line.toUpperCase();
  for (const id of gate.validatedIds) {
    if ((!kind || kind.test(id)) && upper.includes(id)) return true;
  }
  return false;
}

function redactLine(line: string, gate: CitationGate): string {
  let changed = false;
  let next = line;
  if (!lineHasValidatedId(line, gate, DECISION_ID)) {
    next = next.replace(DECISION, () => {
      changed = true;
      return REDACTED;
    });
  }
  if (!lineHasValidatedId(line, gate)) {
    next = next.replace(REGULATORY_TEXT, () => {
      changed = true;
      return REDACTED;
    });
  }
  next = next.replace(ARTICLE_SEQ, (full, seq: string) => {
    const { text, anyAllowed, anyBlocked } = redactSequence(seq, gate);
    if (!anyBlocked) return full;
    changed = true;
    // Aucun numéro validé : on retire tout le « art. … », pas un faux article.
    if (!anyAllowed) return REDACTED;
    return full.replace(seq, text);
  });
  next = next.replace(new RegExp(AUTHORITY_ID.source, "gi"), (id) => {
    if (gate.validatedIds.has(id.toUpperCase())) return id;
    changed = true;
    return REDACTED;
  });
  next = next.replace(POURVOI, () => {
    changed = true;
    return REDACTED;
  });
  next = next.replace(BARE_LNUM, (full, num: string) => {
    if (numAllowed(num, gate)) return full;
    changed = true;
    return REDACTED;
  });
  next = next.replace(BARE_ARTICLE, (full, _num: string, offset: number) => {
    if (skipBareArticle(full, next, offset)) return full;
    if (numAllowed(full, gate)) return full;
    changed = true;
    return REDACTED;
  });
  if (!changed) return next;
  return next
    .replace(REDACTED_RUN, REDACTED)
    .replace(CONFIDENT, "Non vérifié")
    .replace(/✅/g, "");
}

const GATE_NOTE =
  "> Contrôle orchestrateur : une référence non confirmée par legifrance_verify_quote (VALIDATED) a été retirée. Sur ces lignes, « Certain » est devenu « Non vérifié ».";

export function applyCitationGate(text: string, gate: CitationGate): string {
  if (!gate.active) return text;
  const redacted = text.split("\n").map((line) => redactLine(line, gate)).join("\n");
  if (redacted === text) return text;
  return `${redacted.trimEnd()}\n\n${GATE_NOTE}`;
}
