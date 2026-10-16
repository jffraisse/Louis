import { describe, expect, it } from "vitest";
import { applyCitationGate, buildCitationGate, priorForCitator } from "./citation-gate";

const validated =
  "@@CITE status=VALIDATED id=LEGIARTI000032040772 num=1104 version=APPLICABLE@@";
const rejected =
  "@@CITE status=REJECTED id=LEGIARTI000000000008 num=1108 version=EN_VIGUEUR@@";

describe("buildCitationGate", () => {
  it("reste inactif sans sortie de citateur", () => {
    const gate = buildCitationGate([
      { role: "research", output: `${validated}` },
    ]);
    expect(gate.active).toBe(false);
  });

  it("ne lit que la ligne machine, pas le mot VALIDATED en prose", () => {
    const gate = buildCitationGate([
      {
        role: "citator",
        output: `article 1108 VALIDATED LEGIARTI000000000008\n${validated}\n${rejected}`,
      },
    ]);
    expect(gate.active).toBe(true);
    expect(gate.validatedNums.has("1104")).toBe(true);
    expect(gate.validatedNums.has("1108")).toBe(false);
    expect(gate.validatedIds.has("LEGIARTI000032040772")).toBe(true);
    expect(gate.validatedIds.has("LEGIARTI000000000008")).toBe(false);
  });

  it("refuse une version INDISPONIBLE même si le status est VALIDATED", () => {
    const gate = buildCitationGate([
      {
        role: "citator",
        output:
          "@@CITE status=VALIDATED id=LEGIARTI000032040772 num=1104 version=INDISPONIBLE@@",
      },
    ]);
    expect(gate.validatedIds.size).toBe(0);
    expect(gate.validatedNums.size).toBe(0);
  });
});

describe("applyCitationGate", () => {
  const gate = buildCitationGate([
    { role: "citator", output: validated },
  ]);

  it("garde l'article validé et retire l'autre", () => {
    const out = applyCitationGate(
      "L'article 1104 s'applique. L'article 1108 aussi. ✅",
      gate
    );
    expect(out).toContain("article 1104");
    expect(out).not.toContain("1108");
    expect(out).toContain("« non vérifié »");
    expect(out).not.toContain("✅");
    expect(out).toContain("Contrôle orchestrateur");
  });

  it("retire un LEGIARTI absent de l'allowlist", () => {
    const out = applyCitationGate(
      "Voir LEGIARTI000032040772 et LEGIARTI000000000008.",
      gate
    );
    expect(out).toContain("LEGIARTI000032040772");
    expect(out).not.toContain("LEGIARTI000000000008");
  });

  it("ne touche pas une date de loi", () => {
    const out = applyCitationGate("Loi du 21 juin 2004, article 1104.", gate);
    expect(out).toContain("21 juin 2004");
    expect(out).toContain("article 1104");
    expect(out).not.toContain("Contrôle orchestrateur");
  });

  it("ne modifie rien si le citateur n'a pas tourné", () => {
    const idle = buildCitationGate([]);
    const text = "L'article 1108 est inventé. ✅";
    expect(applyCitationGate(text, idle)).toBe(text);
  });

  it("retire un pourvoi dont l'ECLI n'est pas dans une ligne machine", () => {
    const ecliGate = buildCitationGate([
      {
        role: "citator",
        output:
          "@@CITE status=VALIDATED id=ECLI:FR:CCASS:2024:CO00111 num=- version=EN_VIGUEUR@@",
      },
    ]);
    const out = applyCitationGate(
      "Voir ECLI:FR:CCASS:2024:CO00111 et ECLI:FR:CCASS:2020:CO00001.",
      ecliGate
    );
    expect(out).toContain("ECLI:FR:CCASS:2024:CO00111");
    expect(out).not.toContain("ECLI:FR:CCASS:2020:CO00001");
  });
});

describe("priorForCitator", () => {
  it("retire le raisonnement du rédacteur et garde la recherche", () => {
    const outputs = [
      { role: "research", output: "extrait" },
      { role: "drafting", output: "mémo" },
      { role: "orchestrator", output: "synthèse" },
    ];
    expect(priorForCitator("citator", outputs).map((item) => item.role)).toEqual([
      "research",
    ]);
    expect(priorForCitator("orchestrator", outputs)).toHaveLength(3);
  });
});
