import { describe, expect, it } from "vitest";
import {
  articleNumsEqual,
  mapSearchRow,
  pickBestArticleId,
  searchTypeForQuery,
  wantedArticleNum,
} from "./legifrance-map";

describe("wantedArticleNum", () => {
  it("lit un numéro d'article", () => {
    expect(wantedArticleNum("article 1104 du Code civil")).toBe("1104");
    expect(wantedArticleNum("L. 442-1 code de commerce")).toBe("L442-1");
  });

  it("ignore une date de loi, pas un article court", () => {
    expect(wantedArticleNum("loi du 21 juin 2004")).toBeNull();
    expect(wantedArticleNum("version au 15/01/2025")).toBeNull();
    expect(wantedArticleNum("article 21 du Code civil")).toBe("21");
  });
});

describe("articleNumsEqual", () => {
  it("tolère le point après L", () => {
    expect(articleNumsEqual("L. 442-1", "L442-1")).toBe(true);
    expect(articleNumsEqual("1231-5", "1231-1")).toBe(false);
  });
});

describe("searchTypeForQuery", () => {
  it("resserre la recherche quand un article est demandé", () => {
    expect(searchTypeForQuery("1104 Code civil")).toBe(
      "TOUS_LES_MOTS_DANS_UN_CHAMP"
    );
    expect(searchTypeForQuery("responsabilité contractuelle")).toBe(
      "UN_DES_MOTS"
    );
  });
});

describe("mapSearchRow", () => {
  it("préfère le LEGIARTI des extraits au LEGITEXT du hit", () => {
    const hit = mapSearchRow({
      id: "LEGITEXT000006070721",
      titles: [{ title: "Code civil", cid: "LEGITEXT000006070721" }],
      sections: [
        {
          extracts: [
            {
              id: "LEGIARTI000032040772",
              values: ["Les contrats doivent être négociés, formés et exécutés de bonne foi."],
            },
          ],
        },
      ],
    });
    expect(hit.articleId).toBe("LEGIARTI000032040772");
    expect(hit.id).toBe("LEGIARTI000032040772");
    expect(hit.textId).toBe("LEGITEXT000006070721");
    expect(hit.excerpt).toContain("bonne foi");
  });
});

describe("pickBestArticleId", () => {
  const hits = [
    {
      articleId: "LEGIARTI000000000008",
      title: "Article 1108",
      excerpt: "Le contrat est commutatif",
    },
    {
      articleId: "LEGIARTI000032040772",
      title: "Article 1104",
      excerpt: "Les contrats doivent être négociés de bonne foi",
    },
  ];

  it("choisit l'article dont le numéro est dans le titre", () => {
    expect(pickBestArticleId(hits, "1104 Code civil")).toBe(
      "LEGIARTI000032040772"
    );
  });

  it("refuse un hit qui ne porte pas le numéro demandé", () => {
    expect(
      pickBestArticleId(
        [hits[0]!],
        "1104 Code civil"
      )
    ).toBeNull();
  });
});
