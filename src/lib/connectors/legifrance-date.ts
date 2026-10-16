/**
 * Version d'un article à une date. La recherche datée suit la FAQ
 * Légifrance : fond CODE_DATE, facette DATE_VERSION (epoch ms), puis
 * getArticle sur le LEGIARTI renvoyé. Aucun appel réseau ici.
 */

const MONTHS: Record<string, number> = {
  janvier: 1,
  fevrier: 2,
  février: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  août: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
  décembre: 12,
};

/** Midi UTC : la date civile reste la même en France, été comme hiver. */
export function parseAsOf(input: string): number | null {
  const text = input.trim().toLowerCase();
  let year: number;
  let month: number;
  let day: number;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const fr = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const named = text.match(
    /^(\d{1,2})\s+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\s+(\d{4})$/
  );
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (fr) {
    day = Number(fr[1]);
    month = Number(fr[2]);
    year = Number(fr[3]);
  } else if (named) {
    day = Number(named[1]);
    month = MONTHS[named[2]] ?? 0;
    year = Number(named[3]);
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1800 || year > 2200) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

/** « 1104 Code civil » → « Code civil ». La facette NOM_CODE attend le libellé. */
export function codeNameFromQuery(query: string): string | null {
  const match = query.match(
    /\b(code(?:\s+(?:g[ée]n[ée]ral|de la|de l'|du|des|de))?(?:\s+[a-zàâäéèêëïîôùûüç'-]+){1,6})/i
  );
  if (!match) return null;
  const raw = match[1].replace(/\s+/g, " ").trim();
  return `Code ${raw.slice(4).trim().toLowerCase()}`;
}

export function toEpoch(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value;
  }
  const text = String(value).trim();
  if (/^\d{11,}$/.test(text)) return Number(text);
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return null;
  return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
}

const OPEN_ENDED = Date.UTC(2500, 0, 1);

/**
 * Intervalle [dateDebut, dateFin). Une fin absente ou ≥ 2500 est ouverte.
 * Si le début est illisible, la version ne couvre pas la date : on ne
 * devine pas avec l'édition voisine.
 */
export function versionCovers(
  dateDebut: string | number | null | undefined,
  dateFin: string | number | null | undefined,
  asOfMs: number
): boolean {
  const start = toEpoch(dateDebut);
  if (start == null || asOfMs < start) return false;
  const end = toEpoch(dateFin);
  if (end == null || end >= OPEN_ENDED) return true;
  return asOfMs < end;
}

export function datedCodeSearchBody(opts: {
  articleNum: string;
  codeName: string;
  singleDate: number;
}): Record<string, unknown> {
  return {
    fond: "CODE_DATE",
    recherche: {
      champs: [
        {
          typeChamp: "NUM_ARTICLE",
          operateur: "ET",
          criteres: [
            {
              typeRecherche: "EXACTE",
              valeur: opts.articleNum,
              operateur: "ET",
            },
          ],
        },
      ],
      filtres: [
        { facette: "NOM_CODE", valeurs: [opts.codeName] },
        { facette: "DATE_VERSION", singleDate: opts.singleDate },
      ],
      pageNumber: 1,
      pageSize: 10,
      operateur: "ET",
      sort: "PERTINENCE",
      typePagination: "ARTICLE",
    },
  };
}
