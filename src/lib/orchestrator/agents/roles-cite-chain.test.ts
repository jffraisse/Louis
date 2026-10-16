import { describe, expect, it } from "vitest";
import {
  AGENT_DEFAULTS,
  CITATOR_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
} from "./roles";

describe("chaîne Légifrance → @@CITE", () => {
  it("la recherche exige get_article et des extraits littéraux", () => {
    expect(RESEARCH_SYSTEM_PROMPT).toContain("Textes officiels (get_article)");
    expect(RESEARCH_SYSTEM_PROMPT).toContain("legifrance_get_article");
    expect(RESEARCH_SYSTEM_PROMPT).toMatch(/3 à 5 articles/);
    expect(RESEARCH_SYSTEM_PROMPT).toContain("en parallèle");
  });

  it("le citateur doit enchaîner get → verify et interdire l'APPROUVÉ vide", () => {
    expect(CITATOR_SYSTEM_PROMPT).toContain("legifrance_verify_quote");
    expect(CITATOR_SYSTEM_PROMPT).toContain("claimed_quote = CET extrait officiel");
    expect(CITATOR_SYSTEM_PROMPT).toContain("Interdit : « Aucune citation à vérifier »");
    expect(CITATOR_SYSTEM_PROMPT).toMatch(/3 à 5 articles/);
    expect(AGENT_DEFAULTS.citator?.toolAllowlist).toContain(
      "legifrance_verify_quote"
    );
  });
});
