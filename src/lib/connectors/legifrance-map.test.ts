import { describe, expect, it } from "vitest";
import {
  articleNumsEqual,
  listedArticleNums,
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

/**
 * Forme réelle d'une réponse /search (relevée sur l'API de production,
 * cf. Association-DataRing/Louis#25) : un code = UN résultat, plusieurs
 * articles en extraits, le numéro dans `num`, `title` à null, et des
 * passages qui ne contiennent pas le numéro de l'article.
 */
const CODE_CIVIL_ROW = {
  titles: [
    { cid: "LEGITEXT000006070721", title: "Code civil" },
    { cid: "LEGISCTA000006118074", title: null },
  ],
  sections: [
    {
      extracts: [
        {
          id: "LEGIARTI000006438975",
          title: null,
          legalStatus: "ABROGE",
          dateDebut: "1998-05-21T00:00:00.000+0000",
          dateFin: "2016-10-01T00:00:00.000+0000",
          num: "1386-15",
          values: ["[...] Les clauses qui visent à écarter ou à limiter la responsabilité du fait des produits défectueux sont interdites et réputées non écrites. [...]"],
        },
      ],
    },
    {
      extracts: [
        {
          id: "LEGIARTI000032023655",
          title: null,
          legalStatus: "VIGUEUR",
          dateDebut: "2016-10-01T00:00:00.000+0000",
          dateFin: "2999-01-01T00:00:00.000+0000",
          num: "1245-14",
          values: ["[...] Les clauses qui visent à écarter ou à limiter la responsabilité du fait des produits défectueux sont interdites et réputées non écrites. [...]"],
        },
      ],
    },
  ],
};

describe("réponse réelle de l'API (numéro dans extracts[].num)", () => {
  const hit = mapSearchRow(CODE_CIVIL_ROW);

  it("garde chaque article du résultat avec son numéro et ses dates", () => {
    expect(hit.articles.map((a) => [a.id, a.num, a.etat])).toEqual([
      ["LEGIARTI000006438975", "1386-15", "ABROGE"],
      ["LEGIARTI000032023655", "1245-14", "VIGUEUR"],
    ]);
    expect(listedArticleNums([hit])).toEqual(["1386-15", "1245-14"]);
  });

  it("trouve l'article par son numéro même si le passage ne le contient pas", () => {
    expect(pickBestArticleId([hit], "1245-14 Code civil")).toBe(
      "LEGIARTI000032023655"
    );
    expect(pickBestArticleId([hit], "1386-15 Code civil")).toBe(
      "LEGIARTI000006438975"
    );
  });

  it("refuse un article qui cite le numéro sans le porter", () => {
    const citing = mapSearchRow({
      titles: [{ title: "Code civil" }],
      sections: [
        {
          extracts: [
            {
              id: "LEGIARTI000000000001",
              num: "1190",
              values: ["sous réserve de l'article 1171, le contrat s'interprète…"],
            },
          ],
        },
      ],
    });
    expect(pickBestArticleId([citing], "1171 Code civil")).toBeNull();
  });

  it("préfère la version qui couvre la date demandée", () => {
    const versions = mapSearchRow({
      titles: [{ title: "Code civil" }],
      sections: [
        {
          extracts: [
            {
              id: "LEGIARTI000032040794",
              num: "1171",
              legalStatus: "MODIFIE",
              dateDebut: "2016-10-01T00:00:00.000+0000",
              dateFin: "2018-10-01T00:00:00.000+0000",
            },
            {
              id: "LEGIARTI000036829836",
              num: "1171",
              legalStatus: "VIGUEUR",
              dateDebut: "2018-10-01T00:00:00.000+0000",
              dateFin: "2999-01-01T00:00:00.000+0000",
            },
          ],
        },
      ],
    });
    expect(
      pickBestArticleId([versions], "1171 Code civil", {
        asOfMs: Date.UTC(2025, 0, 15, 12),
      })
    ).toBe("LEGIARTI000036829836");
    expect(
      pickBestArticleId([versions], "1171 Code civil", {
        asOfMs: Date.UTC(2017, 5, 1, 12),
      })
    ).toBe("LEGIARTI000032040794");
  });

  it("écarte le même numéro dans un autre code", () => {
    const conso = mapSearchRow({
      titles: [{ title: "Code de la consommation" }],
      sections: [{ extracts: [{ id: "LEGIARTI000000000002", num: "L121-1" }] }],
    });
    expect(pickBestArticleId([conso], "L121-1 Code de commerce")).toBeNull();
    expect(pickBestArticleId([conso], "L. 121-1 Code de la consommation")).toBe(
      "LEGIARTI000000000002"
    );
  });
});
