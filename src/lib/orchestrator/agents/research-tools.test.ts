import { describe, expect, it } from "vitest";
import {
  resolveResearchToolAllowlist,
  researchJudilibreToolChoice,
} from "./research-tools";

describe("resolveResearchToolAllowlist", () => {
  it("laisse null (tous les outils)", () => {
    expect(resolveResearchToolAllowlist(null)).toBeNull();
  });

  it("retire verify_quote et injecte Judilibre même sur allowlist Board obsolète", () => {
    expect(
      resolveResearchToolAllowlist([
        "legifrance_search",
        "legifrance_get_article",
        "legifrance_verify_quote",
        "pappers_search",
      ])
    ).toEqual([
      "legifrance_search",
      "legifrance_get_article",
      "pappers_search",
      "judilibre_search",
      "judilibre_decision",
    ]);
  });

  it("ne duplique pas Judilibre déjà présent", () => {
    const out = resolveResearchToolAllowlist([
      "legifrance_search",
      "judilibre_search",
      "judilibre_decision",
    ]);
    expect(out?.filter((n) => n === "judilibre_search")).toHaveLength(1);
    expect(out?.filter((n) => n === "judilibre_decision")).toHaveLength(1);
  });
});

describe("researchJudilibreToolChoice", () => {
  const available = new Set(["judilibre_search", "judilibre_decision"]);

  it("force judilibre_search après 4 get_article", () => {
    const choice = researchJudilibreToolChoice({
      stepNumber: 3,
      maxSteps: 16,
      availableTools: available,
      steps: [
        {
          toolCalls: [
            { toolName: "legifrance_get_article" },
            { toolName: "legifrance_get_article" },
            { toolName: "legifrance_get_article" },
            { toolName: "legifrance_get_article" },
          ],
        },
      ],
    });
    expect(choice).toEqual({ type: "tool", toolName: "judilibre_search" });
  });

  it("force judilibre_search au step ≥ 6 même sans 4 get_article", () => {
    const choice = researchJudilibreToolChoice({
      stepNumber: 6,
      maxSteps: 16,
      availableTools: available,
      steps: [{ toolCalls: [{ toolName: "legifrance_search" }] }],
    });
    expect(choice).toEqual({ type: "tool", toolName: "judilibre_search" });
  });

  it("force judilibre_decision après search sans decision", () => {
    const choice = researchJudilibreToolChoice({
      stepNumber: 7,
      maxSteps: 16,
      availableTools: available,
      steps: [
        {
          toolCalls: [
            { toolName: "legifrance_get_article" },
            { toolName: "judilibre_search" },
          ],
        },
      ],
    });
    expect(choice).toEqual({ type: "tool", toolName: "judilibre_decision" });
  });

  it("ne force rien au dernier pas ni si Judilibre déjà fait", () => {
    expect(
      researchJudilibreToolChoice({
        stepNumber: 15,
        maxSteps: 16,
        availableTools: available,
        steps: [],
      })
    ).toBeUndefined();

    expect(
      researchJudilibreToolChoice({
        stepNumber: 8,
        maxSteps: 16,
        availableTools: available,
        steps: [
          {
            toolCalls: [
              { toolName: "judilibre_search" },
              { toolName: "judilibre_decision" },
            ],
          },
        ],
      })
    ).toBeUndefined();
  });
});
