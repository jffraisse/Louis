import { describe, expect, it } from "vitest";
import {
  codeNameFromQuery,
  datedCodeSearchBody,
  parseAsOf,
  versionCovers,
} from "./legifrance-date";

describe("parseAsOf", () => {
  it("lit une date ISO, française, ou avec le mois en toutes lettres", () => {
    const iso = parseAsOf("2025-01-15");
    expect(iso).toBe(parseAsOf("15/01/2025"));
    expect(iso).toBe(parseAsOf("15 janvier 2025"));
    expect(new Date(iso!).toISOString().slice(0, 10)).toBe("2025-01-15");
  });

  it("refuse un jour impossible", () => {
    expect(parseAsOf("2025-02-31")).toBeNull();
    expect(parseAsOf("juin 2004")).toBeNull();
  });
});

describe("codeNameFromQuery", () => {
  it("isole le libellé attendu par NOM_CODE", () => {
    expect(codeNameFromQuery("1104 Code civil")).toBe("Code civil");
    expect(codeNameFromQuery("article L. 442-1 du code de commerce")).toBe(
      "Code de commerce"
    );
  });
});

describe("versionCovers", () => {
  const debut = Date.UTC(2016, 9, 1);
  const fin = Date.UTC(2999, 0, 1);

  it("accepte une date dans l'intervalle et refuse l'avant", () => {
    expect(versionCovers(debut, fin, parseAsOf("2025-01-15")!)).toBe(true);
    expect(versionCovers(debut, fin, parseAsOf("2016-09-30")!)).toBe(false);
  });

  it("traite la fin comme exclusive et n'invente pas un début illisible", () => {
    const end = Date.UTC(2020, 0, 1);
    expect(versionCovers(debut, end, parseAsOf("2019-12-31")!)).toBe(true);
    expect(versionCovers(debut, end, parseAsOf("2020-01-01")!)).toBe(false);
    expect(versionCovers(null, fin, parseAsOf("2025-01-15")!)).toBe(false);
  });
});

describe("datedCodeSearchBody", () => {
  it("reprend la facette DATE_VERSION de la FAQ Légifrance", () => {
    const body = datedCodeSearchBody({
      articleNum: "1104",
      codeName: "Code civil",
      singleDate: parseAsOf("2018-01-01")!,
    });
    expect(body.fond).toBe("CODE_DATE");
    const recherche = body.recherche as {
      typePagination: string;
      filtres: Array<{ facette: string; singleDate?: number; valeurs?: string[] }>;
    };
    expect(recherche.typePagination).toBe("ARTICLE");
    expect(recherche.filtres.map((filtre) => filtre.facette)).toEqual([
      "NOM_CODE",
      "DATE_VERSION",
    ]);
    expect(recherche.filtres[1]?.singleDate).toBe(parseAsOf("2018-01-01"));
  });
});
