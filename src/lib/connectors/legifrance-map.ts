/**
 * Fonctions pures : mapping des hits Légifrance et détection d'un numéro
 * d'article. Aucun appel réseau — testable sans PISTE.
 */

export const EXCERPT_MAX = 700;

export type SearchRow = {
  id?: string;
  titles?: Array<{ title?: string; cid?: string }>;
  sections?: Array<{
    extracts?: Array<{ id?: string; values?: string[] }>;
  }>;
  texte?: string;
};

export type MappedHit = {
  /** Identifiant à citer : LEGIARTI si trouvé, sinon identifiant du texte. */
  id: string;
  articleId: string | null;
  textId: string | null;
  title: string;
  excerpt: string | null;
};

const TEXT_ID =
  /^(LEGITEXT|JORFTEXT|JORFARTI|JURITEXT|CETATEXT|KALI)/i;

export function canonicalArticleNum(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .replace(/([LRD])\./gi, "$1")
    .toUpperCase();
}

const CALENDAR_DATE_SOURCE =
  "\\b\\d{1,2}\\s+(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)(?:\\s+\\d{4})?\\b|\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b";

/** Vrai si l'index tombe dans « 21 juin 2004 » ou « 15/01/2025 ». */
function isInsideCalendarDate(query: string, index: number): boolean {
  for (const date of query.matchAll(new RegExp(CALENDAR_DATE_SOURCE, "gi"))) {
    const start = date.index ?? 0;
    if (index >= start && index < start + date[0].length) return true;
  }
  return false;
}

/**
 * Extrait un numéro d'article (« 1104 », « 1231-5 », « L442-1 »).
 * Ignore une date (« 21 juin 2004 », « 15/01/2025 ») et les années
 * 1900–2100, pour ne pas prendre le jour ou l'année d'une loi pour un article.
 */
export function wantedArticleNum(query: string): string | null {
  const matches = query.matchAll(
    /\b((?:[LRD]\.?\s*)?\d{1,4}(?:-\d+){0,3})\b/gi
  );
  for (const match of matches) {
    if (isInsideCalendarDate(query, match.index ?? 0)) continue;
    const num = canonicalArticleNum(match[1] ?? "");
    if (/^\d{4}$/.test(num)) {
      const year = Number(num);
      if (year >= 1900 && year <= 2100) continue;
    }
    return num;
  }
  return null;
}

export function articleNumsEqual(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  return canonicalArticleNum(a) === canonicalArticleNum(b);
}

/** Recherche stricte dès qu'un numéro d'article est dans la requête. */
export function searchTypeForQuery(
  query: string
): "UN_DES_MOTS" | "TOUS_LES_MOTS_DANS_UN_CHAMP" {
  return wantedArticleNum(query)
    ? "TOUS_LES_MOTS_DANS_UN_CHAMP"
    : "UN_DES_MOTS";
}

/**
 * L'API search met souvent l'id du CODE (LEGITEXT) sur le hit, et le
 * LEGIARTI dans sections[].extracts[].id. Sans ça, getArticle est appelé
 * sur le mauvais identifiant.
 */
export function mapSearchRow(row: SearchRow): MappedHit {
  const articleIds: string[] = [];
  const bits: string[] = [];

  for (const section of row.sections ?? []) {
    for (const extract of section.extracts ?? []) {
      if (extract.id && /^LEGIARTI/i.test(extract.id)) {
        articleIds.push(extract.id);
      }
      const value = extract.values?.find((v) => v && v.trim());
      if (value) bits.push(value);
    }
  }
  if (row.texte?.trim()) bits.push(row.texte);

  const textId =
    [row.id, row.titles?.[0]?.cid].find((id) => id && TEXT_ID.test(id)) ??
    null;
  const rowArticle =
    row.id && /^LEGIARTI/i.test(row.id) ? row.id : null;
  const articleId = rowArticle ?? articleIds[0] ?? null;
  const id = articleId ?? textId ?? row.id ?? "";
  const title = row.titles?.[0]?.title?.trim() || id || "Résultat sans titre";
  const excerpt =
    bits.join(" ").replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX) || null;

  return { id, articleId, textId, title, excerpt };
}

function mentionsNum(blob: string, wanted: string): boolean {
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const canon = blob.replace(/([LRD])\.\s*/gi, "$1");
  return new RegExp(`\\b${escaped}\\b`, "i").test(canon);
}

export function pickBestArticleId(
  hits: Array<{
    articleId: string | null;
    title: string;
    excerpt?: string | null;
  }>,
  query: string
): string | null {
  const wanted = wantedArticleNum(query);
  const ranked = hits
    .filter((hit) => hit.articleId)
    .map((hit) => {
      const blob = `${hit.title} ${hit.excerpt ?? ""}`;
      const hitMentions = wanted ? mentionsNum(blob, wanted) : false;
      return {
        id: hit.articleId as string,
        score: (hitMentions ? 10 : 0) + 1,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;
  // Un numéro demandé doit apparaître dans le hit, sinon on refuse
  // plutôt que d'ouvrir le mauvais article.
  if (wanted && best.score < 10) return null;
  return best.id;
}
