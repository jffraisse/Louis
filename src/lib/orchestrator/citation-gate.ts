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

const CITE_MARKER =
  /@@CITE\s+status=(VALIDATED|REJECTED|INTROUVABLE)\s+id=(\S+)\s+num=(\S+)\s+version=(EN_VIGUEUR|APPLICABLE|INDISPONIBLE)\s*@@/gi;

const ARTICLE_SEQ =
  /(?:articles?|art\.?)\s+((?:[LRD]\.?\s*)?\d{1,4}(?:-\d+){0,3}(?:\s*(?:,|et|ou)\s*(?:[LRD]\.?\s*)?\d{1,4}(?:-\d+){0,3})*)/gi;
const BARE_LNUM = /\b([LRD]\.\s*\d{1,4}(?:-\d+){0,3})\b/gi;
const AUTHORITY_ID = /LEGIARTI\d+|JURITEXT\d+|CETATEXT\d+|ECLI:FR:[A-Z0-9:.]+/gi;

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

function redactSequence(sequence: string, gate: CitationGate): string {
  return sequence
    .split(/(\s*(?:,|et|ou)\s*)/i)
    .map((part) => {
      if (/^\s*(?:,|et|ou)\s*$/i.test(part)) return part;
      return numAllowed(part, gate) ? part : "« non vérifié »";
    })
    .join("");
}

function redactLine(line: string, gate: CitationGate): string {
  let changed = false;
  let next = line.replace(new RegExp(ARTICLE_SEQ.source, "gi"), (full, seq: string) => {
    const replaced = redactSequence(seq, gate);
    const rebuilt = full.replace(seq, replaced);
    if (rebuilt !== full) changed = true;
    return rebuilt;
  });
  next = next.replace(new RegExp(AUTHORITY_ID.source, "gi"), (id) => {
    if (gate.validatedIds.has(id.toUpperCase())) return id;
    changed = true;
    return "« non vérifié »";
  });
  next = next.replace(new RegExp(BARE_LNUM.source, "gi"), (full, num: string) => {
    if (numAllowed(num, gate)) return full;
    changed = true;
    return "« non vérifié »";
  });
  if (changed) next = next.replace(/✅/g, "");
  return next;
}

const GATE_NOTE =
  "> Contrôle orchestrateur : une référence non confirmée par legifrance_verify_quote (VALIDATED) a été retirée.";

export function applyCitationGate(text: string, gate: CitationGate): string {
  if (!gate.active) return text;
  const redacted = text.split("\n").map((line) => redactLine(line, gate)).join("\n");
  if (redacted === text) return text;
  return `${redacted.trimEnd()}\n\n${GATE_NOTE}`;
}
