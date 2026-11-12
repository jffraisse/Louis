import { describe, expect, it } from "vitest";
import {
  ensureIntermediateText,
  looksLikeLeakedToolCall,
} from "./intermediate-text";

describe("looksLikeLeakedToolCall", () => {
  it("détecte le XML tool_call / function=", () => {
    expect(
      looksLikeLeakedToolCall(
        `<tool_call> <function=legifrance_get_article> <parameter=id> LEGIARTI1 </parameter> </function> </tool_call>`
      )
    ).toBe(true);
  });

  it("ignore une note normale", () => {
    expect(looksLikeLeakedToolCall("## Vérification\n@@CITE status=VALIDATED")).toBe(
      false
    );
  });
});

describe("ensureIntermediateText", () => {
  it("laisse passer un texte non vide", () => {
    expect(
      ensureIntermediateText("citator", "Citateur", "@@CITE status=VALIDATED")
    ).toContain("@@CITE");
  });

  it("remplace une fuite tool_call par un diagnostic", () => {
    const out = ensureIntermediateText(
      "citator",
      "Citateur",
      `<tool_call> <function=legifrance_verify_quote> </function> </tool_call>`
    );
    expect(out).toContain("appel d'outil non exécuté");
    expect(out).toContain("RÉVISION NÉCESSAIRE");
    expect(out).not.toContain("<tool_call");
  });

  it("fournit un verdict RÉVISION si le citateur est vide", () => {
    const out = ensureIntermediateText("citator", "Citateur", "  ");
    expect(out).toContain("RÉVISION NÉCESSAIRE");
  });
});
