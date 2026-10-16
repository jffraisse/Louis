import { toolError, toolOk, runTool, type ToolResult } from "@/lib/tools/result";
import {
  articleNumsEqual,
  mapSearchRow,
  pickBestArticleId,
  wantedArticleNum,
  type SearchRow,
} from "./legifrance-map";
import {
  isArticleId,
  isOverbroadTextId,
  verdictForQuote,
  type QuoteVerdict,
} from "./cite-verify";
import {
  codeNameFromQuery,
  datedCodeSearchBody,
  parseAsOf,
  versionCovers,
} from "./legifrance-date";
import {
  LEGIFRANCE_PATH,
  legifranceSearch,
  legifranceUrlForId,
  pisteFetch,
} from "./piste";
export type ArticleVersion = "EN_VIGUEUR" | "APPLICABLE" | "INDISPONIBLE";

export type LegifranceArticle = {
  id: string;
  num: string;
  codeTitle: string;
  etat: string;
  dateDebut: string | null;
  dateFin: string | null;
  texte: string;
  url: string;
  version: ArticleVersion;
  asOf: string | null;
};

type TitleNode = { titre?: string; title?: string } | string;

type GetArticleRaw = {
  article?: {
    id?: string;
    num?: string;
    texte?: string;
    texteHtml?: string;
    etat?: string;
    dateDebut?: string | number;
    dateFin?: string | number;
    textTitles?: TitleNode[];
    fullSectionsTitre?: string;
  };
};

function asText(value: string | number | undefined | null): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function titleOf(node: TitleNode | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return node.titre ?? node.title ?? "";
}

export function stripLegalHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchArticleById(
  userId: string,
  articleId: string
): Promise<ToolResult<LegifranceArticle>> {
  const fetched = await pisteFetch<GetArticleRaw>(
    userId,
    "POST",
    `${LEGIFRANCE_PATH}/consult/getArticle`,
    { body: { id: articleId }, serviceName: "Légifrance" }
  );
  if (!fetched.ok) return fetched;

  const article = fetched.data.article;
  const rawText = article?.texte || article?.texteHtml || "";
  if (!article?.id || !rawText.trim()) {
    return toolError("validation", `Article ${articleId} introuvable ou sans texte.`);
  }

  return toolOk({
    id: article.id,
    num: article.num ?? "",
    codeTitle: titleOf(article.textTitles?.[0]) || article.fullSectionsTitre || "",
    etat: article.etat ?? "",
    dateDebut: asText(article.dateDebut),
    dateFin: asText(article.dateFin),
    texte: stripLegalHtml(rawText),
    url: legifranceUrlForId(article.id),
    version: "EN_VIGUEUR",
    asOf: null,
  });
}

function unavailable(message: string) {
  return toolError("validation", `INDISPONIBLE : ${message}`);
}

export async function legifranceGetArticle(
  userId: string,
  opts: { id?: string; query?: string; asOf?: string }
): Promise<ToolResult<{ article: LegifranceArticle }>> {
  return runTool(async () => {
    const asOfRaw = opts.asOf?.trim() ?? "";
    const asOfMs = asOfRaw ? parseAsOf(asOfRaw) : null;
    if (asOfRaw && asOfMs == null) {
      return toolError(
        "validation",
        "Date illisible. Utilisez YYYY-MM-DD, par exemple 2025-01-15."
      );
    }

    let articleId = opts.id?.trim() ?? "";
    if (articleId && isOverbroadTextId(articleId)) {
      return toolError(
        "validation",
        `${articleId} est un identifiant de texte entier (LEGITEXT), pas un article. Passez un LEGIARTI ou une query du type « 1104 Code civil ».`
      );
    }

    if (asOfMs != null) {
      const query = opts.query?.trim() ?? "";
      const codeName = query ? codeNameFromQuery(query) : null;
      const num = query ? wantedArticleNum(query) : null;
      if (codeName && num) {
        const searched = await pisteFetch<{ results?: SearchRow[] }>(
          userId,
          "POST",
          `${LEGIFRANCE_PATH}/search`,
          {
            body: datedCodeSearchBody({
              articleNum: num,
              codeName,
              singleDate: asOfMs,
            }),
            serviceName: "Légifrance",
          }
        );
        if (!searched.ok) return searched;
        const hits = (searched.data.results ?? []).map(mapSearchRow);
        const picked = pickBestArticleId(hits, query);
        if (!picked) {
          return unavailable(
            `aucun article ${num} du ${codeName} au ${asOfRaw}. L'édition voisine n'est pas renvoyée.`
          );
        }
        articleId = picked;
      } else if (!isArticleId(articleId)) {
        return unavailable(
          "pour une date, indiquez query=« numéro + nom du code », par exemple « 1104 Code civil »."
        );
      }

      const loaded = await fetchArticleById(userId, articleId);
      if (!loaded.ok) return loaded;
      if (!versionCovers(loaded.data.dateDebut, loaded.data.dateFin, asOfMs)) {
        return unavailable(
          `${loaded.data.id} (du ${loaded.data.dateDebut ?? "?"} au ${loaded.data.dateFin ?? "?"}) ne couvre pas le ${asOfRaw}. L'édition voisine n'est pas renvoyée.`
        );
      }
      return toolOk({
        article: { ...loaded.data, version: "APPLICABLE", asOf: asOfRaw },
      });
    }

    if (!isArticleId(articleId)) {
      const query = opts.query?.trim();
      if (!query) {
        return toolError(
          "validation",
          "Fournissez id=LEGIARTI… ou query=« numéro + nom du code »."
        );
      }
      const search = await legifranceSearch(userId, query, "CODE_DATE");
      if (!search.ok) return search;
      const picked = pickBestArticleId(search.data.hits, query);
      if (!picked) {
        return toolError(
          "validation",
          `Aucun article LEGIARTI correspondant à « ${query} ». Les hits étaient des textes entiers ou un autre numéro. Relancez avec le numéro exact et le nom du code.`
        );
      }
      articleId = picked;
    }

    const loaded = await fetchArticleById(userId, articleId);
    if (!loaded.ok) return loaded;
    return toolOk({ article: loaded.data });
  });
}

export async function legifranceVerifyQuote(
  userId: string,
  opts: {
    claimed_quote: string;
    article_id?: string;
    query?: string;
    expected_num?: string;
    asOf?: string;
  }
): Promise<
  ToolResult<{
    status: QuoteVerdict;
    article_id: string | null;
    num: string | null;
    etat: string | null;
    date_debut: string | null;
    url: string | null;
    official_excerpt: string | null;
    version: ArticleVersion;
    as_of: string | null;
    note: string;
  }>
> {
  return runTool(async () => {
    const expected =
      opts.expected_num?.trim() ||
      (opts.query ? wantedArticleNum(opts.query) : null);

    const got = await legifranceGetArticle(userId, {
      id: opts.article_id,
      query: opts.query,
      asOf: opts.asOf,
    });

    if (!got.ok) {
      return toolOk({
        status: "INTROUVABLE" as const,
        article_id: opts.article_id ?? null,
        num: null,
        etat: null,
        date_debut: null,
        url: null,
        official_excerpt: null,
        version: got.error.includes("INDISPONIBLE") ? "INDISPONIBLE" : "EN_VIGUEUR",
        as_of: opts.asOf ?? null,
        note: got.error,
      });
    }

    const { article } = got.data;
    if (expected && article.num && !articleNumsEqual(expected, article.num)) {
      return toolOk({
        status: "REJECTED" as const,
        article_id: article.id,
        num: article.num,
        etat: article.etat,
        date_debut: article.dateDebut,
        url: article.url,
        official_excerpt: article.texte.slice(0, 500),
        version: article.version,
        as_of: article.asOf,
        note: `Mauvais article : attendu ${expected}, texte officiel = article ${article.num}. Ne pas approuver.`,
      });
    }

    const status = verdictForQuote(article.texte, opts.claimed_quote);
    return toolOk({
      status,
      article_id: article.id,
      num: article.num,
      etat: article.etat,
      date_debut: article.dateDebut,
      url: article.url,
      official_excerpt: article.texte.slice(0, 500),
      version: article.version,
      as_of: article.asOf,
      note:
        status === "VALIDATED"
          ? "La citation est contenue dans le texte officiel."
          : "La citation n'est pas dans le texte officiel. Collez official_excerpt, n'approuvez pas.",
    });
  });
}
