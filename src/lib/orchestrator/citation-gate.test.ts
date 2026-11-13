import { describe, expect, it } from "vitest";
import {
  applyCitationGate,
  buildCitationGate,
  priorForCitator,
  REDACTED,
} from "./citation-gate";

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

  it("reste inactif si le citateur a tourné sans produire de texte", () => {
    const gate = buildCitationGate([{ role: "citator", output: "   " }]);
    expect(gate.active).toBe(false);
  });

  it("reste inactif si le citateur a collé un tool_call en prose", () => {
    const gate = buildCitationGate([
      {
        role: "citator",
        output:
          "<tool_call> <function=legifrance_verify_quote> </function> </tool_call>",
      },
    ]);
    expect(gate.active).toBe(false);
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

  it("récupère id/num depuis un tableau VALIDATED si @@CITE manque", () => {
    const gate = buildCitationGate([
      {
        role: "citator",
        output:
          "art. 1171 Code civil VALIDATED LEGIARTI000036829836 1171 APPLICABLE https://example.test",
      },
    ]);
    expect(gate.active).toBe(true);
    expect(gate.validatedIds.has("LEGIARTI000036829836")).toBe(true);
    expect(gate.validatedNums.has("1171")).toBe(true);
  });

  it("accepte une décision Judilibre avec version = date ISO", () => {
    const gate = buildCitationGate([
      {
        role: "citator",
        output:
          "@@CITE status=VALIDATED id=ECLI:FR:CCASS:2011:CO00011 num=09-16.863 version=2011-01-18@@",
      },
    ]);
    expect(gate.validatedIds.has("ECLI:FR:CCASS:2011:CO00011")).toBe(true);
    expect(gate.validatedPourvois.has("09-16.863")).toBe(true);
  });

  it("récupère pourvoi + ECLI depuis le tableau du citateur", () => {
    const gate = buildCitationGate([
      {
        role: "citator",
        output:
          "Chambre commerciale, 18 janvier 2011, 09-16.863\tVALIDATED ✅\tECLI:FR:CCASS:2011:CO00011\t-\t2011-01-18",
      },
    ]);
    expect(gate.validatedIds.has("ECLI:FR:CCASS:2011:CO00011")).toBe(true);
    expect(gate.validatedPourvois.has("09-16.863")).toBe(true);
  });
});

describe("applyCitationGate", () => {
  const gate = buildCitationGate([
    { role: "citator", output: validated },
  ]);

  it("garde l'article validé et retire l'autre sans laisser art. …", () => {
    const out = applyCitationGate(
      "L'article 1104 s'applique. L'article 1108 aussi. ✅",
      gate
    );
    expect(out).toContain("article 1104");
    expect(out).not.toContain("1108");
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/art(?:icle)?\.?\s*« référence retirée/i);
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

  it("retire les numéros nus absents de l'allowlist", () => {
    const out = applyCitationGate(
      "Code civil – art. 1104, 1109 (cause), 1110 (objet), 1231‑1.",
      gate
    );
    expect(out).toContain("1104");
    expect(out).not.toContain("1109");
    expect(out).not.toContain("1110");
    expect(out).not.toContain("1231");
    expect(out).toContain(REDACTED);
  });

  it("ne confond pas une loi n° ni une durée avec un article", () => {
    const out = applyCitationGate(
      "Loi n° 2004-575, contrat de 24 mois, article 1104.",
      gate
    );
    expect(out).toContain("2004-575");
    expect(out).toContain("24 mois");
    expect(out).toContain("article 1104");
  });

  it("ne confond pas une date ISO as_of ni un code HTTP avec un article", () => {
    const out = applyCitationGate(
      "Version APPLICABLE, asOf 2025-01-31. Judilibre a refusé l'authentification (403). Article 1104.",
      gate
    );
    expect(out).toContain("2025-01-31");
    expect(out).toContain("(403)");
    expect(out).toContain("Article 1104");
    expect(out).not.toContain("Contrôle orchestrateur");
  });

  it("retire un numéro de pourvoi inventé, tiret typographique compris", () => {
    const out = applyCitationGate("Voir le pourvoi n° 17‑14.125.", gate);
    expect(out).not.toContain("14.125");
    expect(out).toContain(REDACTED);
  });

  it("retire un arrêt cité par sa date sans identifiant validé", () => {
    const out = applyCitationGate(
      "Jurisprudence Cour de cassation (ex. : civ. 1ʳᵉ, 12 octobre 2018) sur la résolution.",
      gate
    );
    expect(out).not.toContain("12 octobre 2018");
    expect(out).toContain(REDACTED);
  });

  it("garde l'arrêt si son ECLI validé est sur la même ligne", () => {
    const ecliGate = buildCitationGate([
      {
        role: "citator",
        output:
          "@@CITE status=VALIDATED id=ECLI:FR:CCASS:2024:CO00111 num=- version=EN_VIGUEUR@@",
      },
    ]);
    const text = "Cass. com., 3 avril 2024, ECLI:FR:CCASS:2024:CO00111.";
    expect(applyCitationGate(text, ecliGate)).toBe(text);
  });

  it("garde ECLI et pourvoi d'une décision Judilibre VALIDATED (version date)", () => {
    const ecliGate = buildCitationGate([
      {
        role: "citator",
        output:
          "@@CITE status=VALIDATED id=ECLI:FR:CCASS:2011:CO00011 num=09-16.863 version=2011-01-18@@",
      },
    ]);
    const text =
      "Cass. com., 18 janvier 2011, pourvoi n° 09-16.863, ECLI:FR:CCASS:2011:CO00011.";
    expect(applyCitationGate(text, ecliGate)).toBe(text);
  });

  it("garde Cass. + date si le pourvoi VALIDATED est sur la même ligne sans ECLI", () => {
    const ecliGate = buildCitationGate([
      {
        role: "citator",
        output:
          "@@CITE status=VALIDATED id=ECLI:FR:CCASS:2010:CO00732 num=09-11.841 version=2010-06-29@@",
      },
    ]);
    const text =
      "Cass. com., 29 juin 2010, pourvoi n° 09-11.841 — clause limitative.";
    expect(applyCitationGate(text, ecliGate)).toBe(text);
  });

  it("abaisse « Certain » sur une ligne où une référence a été retirée", () => {
    const out = applyCitationGate(
      "Code civil – art. 1109 (cause)\tCertain (articles de base du Code civil).",
      gate
    );
    const [row] = out.split("\n");
    expect(row).not.toMatch(/\bCertain\b/);
    expect(row).toContain("Non vérifié");
  });

  it("laisse « Certain » sur une ligne sans référence retirée", () => {
    const text = "Calcul du taux d'indisponibilité\tCertain (calcul du taux).";
    expect(applyCitationGate(text, gate)).toBe(text);
  });

  it("retire un décret ou un arrêté non sourcé, sans résidu", () => {
    const out = applyCitationGate(
      "Décret n° 2016‑1171 du 24 août 2016 ; Arrêté du 30 décembre 2015.",
      gate
    );
    expect(out).not.toMatch(/1171|2016|2015/);
    expect(out.split("\n")[0]).toBe(`${REDACTED} ; ${REDACTED}.`);
  });

  it("garde un décret si un identifiant validé est sur la même ligne", () => {
    const text =
      "Décret n° 2016-1171 du 24 août 2016 (LEGIARTI000032040772).";
    expect(applyCitationGate(text, gate)).toBe(text);
  });

  it("fusionne une plage d'articles retirés", () => {
    const out = applyCitationGate("art. 1231‑1 à 1231‑3 du Code civil.", gate);
    expect(out.split("\n")[0]).toBe(`${REDACTED} du Code civil.`);
  });

  it("fusionne les retraits consécutifs", () => {
    const out = applyCitationGate("Voir 1109, 1110 et 1192.", gate);
    expect(out.split(REDACTED)).toHaveLength(2);
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
