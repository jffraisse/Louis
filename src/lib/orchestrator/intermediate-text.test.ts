import { describe, expect, it } from "vitest";
import { ensureIntermediateText } from "./intermediate-text";

describe("ensureIntermediateText", () => {
  it("laisse passer un texte non vide", () => {
    expect(
      ensureIntermediateText("citator", "Citateur", "@@CITE status=VALIDATED")
    ).toContain("@@CITE");
  });

  it("fournit un verdict RÉVISION si le citateur est vide", () => {
    const out = ensureIntermediateText("citator", "Citateur", "  ");
    expect(out).toContain("RÉVISION NÉCESSAIRE");
    expect(out).toContain("Vérification des citations");
  });

  it("marque les autres rôles vides", () => {
    expect(ensureIntermediateText("research", "Recherche", "")).toContain(
      "Recherche"
    );
  });
});
