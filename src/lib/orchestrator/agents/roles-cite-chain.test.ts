import { describe, expect, it } from "vitest";
import {
  AGENT_DEFAULTS,
  CITATOR_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
} from "./roles";

describe("chaîne Légifrance → @@CITE", () => {
  it("la recherche exige get_article sans inventer de sources", () => {
    expect(RESEARCH_SYSTEM_PROMPT).toContain("legifrance_get_article");
    expect(RESEARCH_SYSTEM_PROMPT).toContain("N'invente ni décret");
  });

  it("le citateur vérifie les citations de la Recherche et n'approuve pas à vide", () => {
    expect(CITATOR_SYSTEM_PROMPT).toContain("legifrance_verify_quote");
    expect(CITATOR_SYSTEM_PROMPT).toContain("@@CITE");
    expect(CITATOR_SYSTEM_PROMPT).toContain("RÉVISION NÉCESSAIRE");
    expect(CITATOR_SYSTEM_PROMPT).toContain(
      "Ne choisis pas toi-même une liste d'articles à valider"
    );
    expect(AGENT_DEFAULTS.citator?.toolAllowlist).toContain(
      "legifrance_verify_quote"
    );
  });
});
