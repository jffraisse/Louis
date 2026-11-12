import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchRow } from "./legifrance-map";

/**
 * Faux PISTE : getArticle lit `ARTICLES`, la recherche datée renvoie
 * `datedRows`, la recherche plein texte renvoie `freeTextHits`.
 */
const state = vi.hoisted(() => ({
  datedRows: [] as unknown[],
  freeTextHits: [] as unknown[],
  calls: [] as string[],
}));

const V2016 = 1475280000000; // 2016-10-01
const V2018 = 1538352000000; // 2018-10-01
const OPEN = 32472144000000; // 2999-01-01

const ARTICLES: Record<string, Record<string, unknown>> = {
  LEGIARTI000036829836: {
    id: "LEGIARTI000036829836",
    num: "1171",
    texte: "Dans un contrat d'adhésion, toute clause non négociable est réputée non écrite.",
    etat: "VIGUEUR",
    dateDebut: V2018,
    dateFin: OPEN,
    textTitles: [{ titre: "Code civil" }],
  },
  LEGIARTI000032040794: {
    id: "LEGIARTI000032040794",
    num: "1171",
    texte: "Dans un contrat d'adhésion, toute clause qui crée un déséquilibre significatif est réputée non écrite.",
    etat: "MODIFIE",
    dateDebut: V2016,
    dateFin: V2018,
    textTitles: [{ titre: "Code civil" }],
  },
  LEGIARTI000029109585: {
    id: "LEGIARTI000029109585",
    num: "L441-6",
    texte: "Tout producteur, prestataire de services, grossiste ou importateur est tenu de communiquer ses conditions générales de vente.",
    etat: "MODIFIE",
    dateDebut: 1403222400000, // 2014-06-20
    dateFin: 1438992000000, // 2015-08-08
    textTitles: [{ titre: "Code de commerce" }],
  },
};

vi.mock("./piste", () => ({
  LEGIFRANCE_PATH: "/lf",
  legifranceUrlForId: (id: string) => `https://www.legifrance.gouv.fr/codes/article_lc/${id}`,
  legifranceSearch: vi.fn(async (_userId: string, query: string) => {
    state.calls.push("recherche plein texte");
    return { ok: true, data: { query, hits: state.freeTextHits } };
  }),
  pisteFetch: vi.fn(
    async (_userId: string, _method: string, path: string, opts: { body: { id?: string } }) => {
      if (path.endsWith("/search")) {
        state.calls.push("recherche datée");
        return { ok: true, data: { results: state.datedRows } };
      }
      state.calls.push(`getArticle ${opts.body.id}`);
      return { ok: true, data: { article: ARTICLES[opts.body.id ?? ""] } };
    }
  ),
}));

import { legifranceGetArticle, legifranceVerifyQuote } from "./legifrance-article";

/** Forme réelle : le numéro est dans extracts[].num, pas dans le passage. */
function codeCivilRow(extracts: NonNullable<SearchRow["sections"]>[number]["extracts"]): SearchRow {
  return {
    titles: [{ cid: "LEGITEXT000006070721", title: "Code civil" }],
    sections: [{ extracts }],
  };
}

const ROW_1171 = codeCivilRow([
  {
    id: "LEGIARTI000036829836",
    title: null,
    num: "1171",
    legalStatus: "VIGUEUR",
    dateDebut: "2018-10-01T00:00:00.000+0000",
    dateFin: "2999-01-01T00:00:00.000+0000",
    values: ["[...] toute clause non négociable [...]"],
  },
]);

beforeEach(() => {
  state.datedRows = [];
  state.freeTextHits = [];
  state.calls = [];
});

describe("legifranceGetArticle avec as_of", () => {
  it("accepte le LEGIARTI fourni s'il couvre la date, sans passer par la recherche", async () => {
    const got = await legifranceGetArticle("u", {
      id: "LEGIARTI000036829836",
      query: "1171 Code civil",
      asOf: "2025-01-15",
    });
    expect(got.ok && got.data.article).toMatchObject({
      id: "LEGIARTI000036829836",
      version: "APPLICABLE",
      asOf: "2025-01-15",
    });
    expect(state.calls).toEqual(["getArticle LEGIARTI000036829836"]);
  });

  it("trouve l'article par numéro + code + date (cas du Citateur)", async () => {
    state.datedRows = [ROW_1171];
    const got = await legifranceGetArticle("u", {
      query: "1171 Code civil",
      asOf: "2025-01-15",
    });
    expect(got.ok && got.data.article).toMatchObject({
      id: "LEGIARTI000036829836",
      num: "1171",
      version: "APPLICABLE",
    });
  });

  it("retombe sur la version en vigueur quand la recherche datée ne rend rien", async () => {
    state.freeTextHits = [
      { articleId: "LEGIARTI000036829836", title: "Code civil", excerpt: "article 1171" },
    ];
    const got = await legifranceGetArticle("u", {
      query: "1171 Code civil",
      asOf: "2025-01-15",
    });
    expect(got.ok && got.data.article.version).toBe("APPLICABLE");
  });

  it("ne renvoie pas la version en vigueur si elle ne couvre pas la date", async () => {
    state.freeTextHits = [
      { articleId: "LEGIARTI000036829836", title: "Code civil", excerpt: "article 1171" },
    ];
    const got = await legifranceGetArticle("u", {
      query: "1171 Code civil",
      asOf: "2017-06-01",
    });
    expect(got).toMatchObject({ ok: false, reason: "validation" });
    expect(!got.ok && got.error).toContain("INDISPONIBLE");
    expect(!got.ok && got.error).toContain("recherche datée sans résultat");
    expect(!got.ok && got.error).toContain(
      "LEGIARTI000036829836 (du 2018-10-01 au 2999-01-01) ne couvre pas le 2017-06-01"
    );
  });

  it("prend la version historique que la recherche datée désigne", async () => {
    state.datedRows = [
      codeCivilRow([
        { id: "LEGIARTI000032040794", num: "1171", dateDebut: V2016, dateFin: V2018 },
        { id: "LEGIARTI000036829836", num: "1171", dateDebut: V2018, dateFin: OPEN },
      ]),
    ];
    const got = await legifranceGetArticle("u", {
      query: "1171 Code civil",
      asOf: "2017-06-01",
    });
    expect(got.ok && got.data.article.id).toBe("LEGIARTI000032040794");
  });

  it("refuse un LEGIARTI d'une autre époque et dit pourquoi", async () => {
    const got = await legifranceGetArticle("u", {
      id: "LEGIARTI000029109585",
      asOf: "2025-01-15",
    });
    expect(!got.ok && got.error).toBe(
      "INDISPONIBLE : LEGIARTI000029109585 (du 2014-06-20 au 2015-08-08) ne couvre pas le 2025-01-15. L'édition voisine n'est pas renvoyée."
    );
  });

  it("refuse un LEGIARTI qui n'est pas le numéro demandé", async () => {
    const got = await legifranceGetArticle("u", {
      id: "LEGIARTI000036829836",
      query: "1219 Code civil",
      asOf: "2025-01-15",
    });
    expect(!got.ok && got.error).toContain("est l'article 1171, pas le 1219");
  });

  it("décrit ce que la recherche a renvoyé quand aucun numéro ne correspond", async () => {
    state.datedRows = [
      codeCivilRow([{ id: "LEGIARTI000000000009", num: "1190", values: ["cf. article 1171"] }]),
    ];
    const got = await legifranceGetArticle("u", {
      query: "1171 Code civil",
      asOf: "2025-01-15",
    });
    expect(!got.ok && got.error).toContain(
      "recherche datée : 1 résultat(s), 1 article(s), numéros 1190"
    );
  });
});

describe("legifranceGetArticle sans date", () => {
  it("résout numéro + code par la recherche exacte", async () => {
    state.datedRows = [ROW_1171];
    const got = await legifranceGetArticle("u", { query: "1171 Code civil" });
    expect(got.ok && got.data.article).toMatchObject({
      id: "LEGIARTI000036829836",
      version: "EN_VIGUEUR",
      asOf: null,
    });
    expect(state.calls).not.toContain("recherche plein texte");
  });

  it("garde la recherche plein texte en secours", async () => {
    state.freeTextHits = [
      { articleId: "LEGIARTI000036829836", title: "Article 1171", excerpt: "contrat d'adhésion" },
    ];
    const got = await legifranceGetArticle("u", { query: "1171 Code civil" });
    expect(got.ok && got.data.article.id).toBe("LEGIARTI000036829836");
    expect(state.calls).toContain("recherche plein texte");
  });
});

describe("legifranceVerifyQuote avec as_of", () => {
  it("valide une citation datée à partir de numéro + code", async () => {
    state.datedRows = [ROW_1171];
    const got = await legifranceVerifyQuote("u", {
      claimed_quote: "toute clause non négociable est réputée non écrite",
      query: "1171 Code civil",
      expected_num: "1171",
      asOf: "2025-01-15",
    });
    expect(got.ok && got.data).toMatchObject({
      status: "VALIDATED",
      article_id: "LEGIARTI000036829836",
      version: "APPLICABLE",
      as_of: "2025-01-15",
    });
  });
});
