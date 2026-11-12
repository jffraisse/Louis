import { toolError, toolOk, runTool, type ToolResult } from "@/lib/tools/result";
import {
  articleNumsEqual,
  isOtherCode,
  listedArticleNums,
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
  isoDay,
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

/**
 * Recherche d'un article par numéro exact dans un code, à une date (FAQ
 * Légifrance : NUM_ARTICLE + NOM_CODE + DATE_VERSION). `seen` décrit ce que
 * l'API a renvoyé, pour qu'un refus dise s'il n'y avait rien ou si aucun
 * résultat ne portait le numéro.
 */
async function findArticleByNumber(
  userId: string,
  opts: { query: string; num: string; codeName: string; dateMs: number }
): Promise<ToolResult<{ id: string | null; seen: string }>> {
  const searched = await pisteFetch<{ results?: SearchRow[] }>(
    userId,
    "POST",
    `${LEGIFRANCE_PATH}/search`,
    {
      body: datedCodeSearchBody({
        articleNum: opts.num,
        codeName: opts.codeName,
        singleDate: opts.dateMs,
      }),
      serviceName: "Légifrance",
    }
  );
  if (!searched.ok) return searched;

  const hits = (searched.data.results ?? []).map(mapSearchRow);
  const nums = listedArticleNums(hits);
  const articleCount = hits.reduce((n, hit) => n + hit.articles.length, 0);
  const seen =
    hits.length === 0
      ? "recherche datée sans résultat"
      : `recherche datée : ${hits.length} résultat(s), ${articleCount} article(s), ${
          nums.length > 0 ? `numéros ${nums.slice(0, 8).join(", ")}` : "sans numéro"
        }`;
  return toolOk({
    id: pickBestArticleId(hits, opts.query, { asOfMs: opts.dateMs }),
    seen,
  });
}

/**
 * LEGIARTI de la version en vigueur aujourd'hui : recherche exacte par
 * numéro quand la requête nomme un code, sinon (ou si elle ne donne rien)
 * recherche plein texte.
 */
async function findCurrentArticleId(
  userId: string,
  opts: { query: string; num: string | null; codeName: string | null }
): Promise<ToolResult<string | null>> {
  if (opts.codeName && opts.num) {
    const found = await findArticleByNumber(userId, {
      query: opts.query,
      num: opts.num,
      codeName: opts.codeName,
      dateMs: Date.now(),
    });
    if (found.ok && found.data.id) return toolOk(found.data.id);
  }
  const search = await legifranceSearch(userId, opts.query, "CODE_DATE");
  if (!search.ok) return search;
  return toolOk(pickBestArticleId(search.data.hits, opts.query));
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

    const query = opts.query?.trim() ?? "";
    const codeName = query ? codeNameFromQuery(query) : null;
    const num = query ? wantedArticleNum(query) : null;

    if (asOfMs != null) {
      // Une version est applicable à la date si son intervalle la contient
      // et si c'est bien le numéro demandé. Chaque candidat écarté laisse
      // sa raison dans `misses`, reprise dans le refus final.
      const misses: string[] = [];
      const tried = new Set<string>();
      const tryVersion = async (
        id: string
      ): Promise<ToolResult<{ article: LegifranceArticle }> | null> => {
        if (tried.has(id)) return null;
        tried.add(id);
        const loaded = await fetchArticleById(userId, id);
        if (!loaded.ok) {
          // Panne (auth, réseau, serveur) : on la remonte telle quelle.
          if (loaded.reason !== "validation") return loaded;
          misses.push(loaded.error);
          return null;
        }
        const article = loaded.data;
        if (num && article.num && !articleNumsEqual(num, article.num)) {
          misses.push(`${article.id} est l'article ${article.num}, pas le ${num}`);
          return null;
        }
        if (codeName && article.codeTitle && isOtherCode(article.codeTitle, codeName)) {
          misses.push(`${article.id} relève du ${article.codeTitle}, pas du ${codeName}`);
          return null;
        }
        if (!versionCovers(article.dateDebut, article.dateFin, asOfMs)) {
          misses.push(
            `${article.id} (du ${isoDay(article.dateDebut)} au ${isoDay(article.dateFin)}) ne couvre pas le ${asOfRaw}`
          );
          return null;
        }
        return toolOk({
          article: { ...article, version: "APPLICABLE", asOf: asOfRaw },
        });
      };

      // 1. Un LEGIARTI fourni désigne une version précise : si elle couvre
      //    la date, c'est la réponse, sans dépendre de la recherche.
      if (isArticleId(articleId)) {
        const direct = await tryVersion(articleId);
        if (direct) return direct;
      }

      if (!(codeName && num)) {
        return unavailable(
          misses.length > 0
            ? `${misses.join(" ; ")}. L'édition voisine n'est pas renvoyée.`
            : "pour une date, indiquez query=« numéro + nom du code », par exemple « 1104 Code civil »."
        );
      }

      // 2. Recherche datée par numéro exact dans le code.
      const found = await findArticleByNumber(userId, {
        query,
        num,
        codeName,
        dateMs: asOfMs,
      });
      if (!found.ok) return found;
      if (found.data.id) {
        const dated = await tryVersion(found.data.id);
        if (dated) return dated;
      } else {
        misses.push(found.data.seen);
      }

      // 3. Version en vigueur aujourd'hui : si elle était déjà en vigueur à
      //    la date demandée, c'est la version applicable.
      const current = await findCurrentArticleId(userId, { query, num, codeName });
      if (current.ok && current.data) {
        const inForce = await tryVersion(current.data);
        if (inForce) return inForce;
      }

      return unavailable(
        `aucun article ${num} du ${codeName} au ${asOfRaw} (${misses.join(" ; ")}). L'édition voisine n'est pas renvoyée.`
      );
    }

    if (!isArticleId(articleId)) {
      if (!query) {
        return toolError(
          "validation",
          "Fournissez id=LEGIARTI… ou query=« numéro + nom du code »."
        );
      }
      const current = await findCurrentArticleId(userId, { query, num, codeName });
      if (!current.ok) return current;
      if (!current.data) {
        return toolError(
          "validation",
          `Aucun article LEGIARTI correspondant à « ${query} ». Les hits étaient des textes entiers ou un autre numéro. Relancez avec le numéro exact et le nom du code.`
        );
      }
      articleId = current.data;
    }

    const loaded = await fetchArticleById(userId, articleId);
    if (!loaded.ok) return loaded;
    return toolOk({ article: loaded.data });
  });
}

type QuoteCheck = {
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
};

export async function legifranceVerifyQuote(
  userId: string,
  opts: {
    claimed_quote: string;
    article_id?: string;
    query?: string;
    expected_num?: string;
    asOf?: string;
  }
): Promise<ToolResult<QuoteCheck>> {
  return runTool<QuoteCheck>(async () => {
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
