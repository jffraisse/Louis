import { describe, expect, it } from "vitest";
import {
  isArticleId,
  isOverbroadTextId,
  normalizeLegalText,
  verdictForQuote,
} from "./cite-verify";

describe("normalizeLegalText", () => {
  it("retire le HTML et les accents", () => {
    expect(normalizeLegalText("<p>Les contrats   doivent être</p>")).toBe(
      "les contrats doivent etre"
    );
  });
});

describe("verdictForQuote", () => {
  const official =
    "Les contrats doivent être négociés, formés et exécutés de bonne foi. Cette disposition est d'ordre public.";

  it("VALIDATED si la citation est dans le texte", () => {
    expect(
      verdictForQuote(
        official,
        "Les contrats doivent être négociés, formés et exécutés de bonne foi"
      )
    ).toBe("VALIDATED");
  });

  it("REJECTED si la citation est celle d'un autre article", () => {
    expect(
      verdictForQuote(
        official,
        "Les contrats légalement formés tiennent lieu de loi à ceux qui les ont faits"
      )
    ).toBe("REJECTED");
  });

  it("INTROUVABLE sans texte officiel", () => {
    expect(verdictForQuote("", "Les contrats doivent être négociés de bonne foi")).toBe(
      "INTROUVABLE"
    );
  });

  it("REJECTED si la citation est trop courte", () => {
    expect(verdictForQuote(official, "bonne foi")).toBe("REJECTED");
  });
});

describe("identifiants", () => {
  it("distingue article et code entier", () => {
    expect(isArticleId("LEGIARTI000032040772")).toBe(true);
    expect(isArticleId("LEGITEXT000006070721")).toBe(false);
    expect(isOverbroadTextId("LEGITEXT000006070721")).toBe(true);
  });
});
