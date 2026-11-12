/**
 * Fonctions pures : mapping des hits Légifrance et détection d'un numéro
 * d'article. Aucun appel réseau — testable sans PISTE.
 */

import { codeNameFromQuery, versionCovers } from "./legifrance-date";

export const EXCERPT_MAX = 700;

/**
 * Un extrait = un article. L'API range son numéro dans `num` (`title` est
 * souvent null) et ses dates de validité dans dateDebut / dateFin.
 */
export type SearchExtract = {
  id?: string;
  num?: string | null;
  title?: string | null;
  legalStatus?: string | null;
  dateDebut?: string | number | null;
  dateFin?: string | number | null;
  values?: string[];
};

export type SearchRow = {
  id?: string;
  titles?: Array<{ title?: string | null; cid?: string }>;
  sections?: Array<{ extracts?: SearchExtract[] }>;
  texte?: string;
};

export type MappedArticle = {
  id: string;
  num: string | null;
  etat: string | null;
  dateDebut: string | number | null;
  dateFin: string | number | null;
};

export type MappedHit = {
  /** Identifiant à citer : LEGIARTI si trouvé, sinon identifiant du texte. */
  id: string;
  articleId: string | null;
  textId: string | null;
  title: string;
  excerpt: string | null;
  /** Tous les articles du résultat : un code renvoie plusieurs extraits. */
  articles: MappedArticle[];
};

const TEXT_ID =
  /^(LEGITEXT|JORFTEXT|JORFARTI|JURITEXT|CETATEXT|KALI)/i;

export function canonicalArticleNum(raw: string): string {
  return raw
    .replace(/[\u2010-\u2015]/g, "-")
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
  const articles: MappedArticle[] = [];
  const bits: string[] = [];

  for (const section of row.sections ?? []) {
    for (const extract of section.extracts ?? []) {
      if (extract.id && /^LEGIARTI/i.test(extract.id)) {
        articles.push({
          id: extract.id,
          num: extract.num?.trim() || null,
          etat: extract.legalStatus?.trim() || null,
          dateDebut: extract.dateDebut ?? null,
          dateFin: extract.dateFin ?? null,
        });
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
  const articleId = rowArticle ?? articles[0]?.id ?? null;
  const id = articleId ?? textId ?? row.id ?? "";
  const title = row.titles?.[0]?.title?.trim() || id || "Résultat sans titre";
  const excerpt =
    bits.join(" ").replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX) || null;

  return { id, articleId, textId, title, excerpt, articles };
}

function mentionsNum(blob: string, wanted: string): boolean {
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const canon = blob.replace(/([LRD])\.\s*/gi, "$1");
  return new RegExp(`\\b${escaped}\\b`, "i").test(canon);
}

function normalizeTitle(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Vrai seulement si le titre est clairement celui d'un AUTRE code. */
export function isOtherCode(title: string, codeName: string | null): boolean {
  if (!codeName) return false;
  const got = normalizeTitle(title);
  const asked = normalizeTitle(codeName);
  if (!got.startsWith("code ")) return false;
  return !got.startsWith(asked) && !asked.startsWith(got);
}

type PickableHit = {
  articleId: string | null;
  title: string;
  excerpt?: string | null;
  articles?: MappedArticle[];
};

/** Numéros d'articles renvoyés par l'API, pour un message d'erreur lisible. */
export function listedArticleNums(hits: PickableHit[]): string[] {
  return hits.flatMap((hit) =>
    (hit.articles ?? []).flatMap((article) => (article.num ? [article.num] : []))
  );
}

/**
 * Quand l'API donne le numéro de chaque article (`num`), on ne se fie qu'à
 * lui : l'article demandé ne contient pas son propre numéro dans son texte,
 * alors qu'un article qui le CITE le contient. Retourne `undefined` si l'API
 * n'a fourni aucun numéro (on retombe alors sur l'ancien critère).
 */
function pickByArticleNum(
  hits: PickableHit[],
  wanted: string,
  query: string,
  asOfMs: number | undefined
): string | null | undefined {
  const codeName = codeNameFromQuery(query);
  const numbered = hits.flatMap((hit) =>
    (hit.articles ?? [])
      .filter((article) => article.num)
      .map((article) => ({ article, title: hit.title }))
  );
  if (numbered.length === 0) return undefined;

  const ranked = numbered
    .filter(
      ({ article, title }) =>
        articleNumsEqual(article.num, wanted) && !isOtherCode(title, codeName)
    )
    .map(({ article }) => {
      const dated = article.dateDebut != null && article.dateDebut !== "";
      const covers =
        asOfMs != null && dated
          ? versionCovers(article.dateDebut, article.dateFin, asOfMs)
          : null;
      const inForce = article.etat?.toUpperCase().startsWith("VIGUEUR") ?? false;
      return {
        id: article.id,
        // Version couvrant la date d'abord ; à défaut de date, celle en vigueur.
        score: (covers === true ? 4 : covers === null ? 2 : 0) + (inForce ? 1 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.id ?? null;
}

export function pickBestArticleId(
  hits: PickableHit[],
  query: string,
  opts: { asOfMs?: number } = {}
): string | null {
  const wanted = wantedArticleNum(query);
  if (wanted) {
    const byNum = pickByArticleNum(hits, wanted, query, opts.asOfMs);
    if (byNum !== undefined) return byNum;
  }
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
