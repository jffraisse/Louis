import { applyCitationGate, buildCitationGate } from "./citation-gate";

/**
 * Correcteur structurel. Une seule citation que le filtre doit retirer
 * fait échouer la fiche. Le jeu de 50 à 100 questions expert n'est pas
 * encore écrit : ces fiches ne testent que la barrière, pas le droit.
 */

export type StrictFixture = {
  id: string;
  answer: string;
  citator: string;
  requiredNums?: string[];
  forbiddenNums?: string[];
};

export type Grade = {
  id: string;
  pass: boolean;
  reasons: string[];
};

export function gradeAnswer(fixture: StrictFixture): Grade {
  const reasons: string[] = [];
  const gate = buildCitationGate([{ role: "citator", output: fixture.citator }]);
  const gated = applyCitationGate(fixture.answer, gate);
  if (gated !== fixture.answer) {
    reasons.push(
      "le filtre a retiré une référence : une seule citation fausse fait échouer la fiche"
    );
  }
  for (const num of fixture.requiredNums ?? []) {
    if (!fixture.answer.includes(num)) reasons.push(`numéro requis absent : ${num}`);
  }
  for (const num of fixture.forbiddenNums ?? []) {
    if (fixture.answer.includes(num)) reasons.push(`numéro interdit présent : ${num}`);
  }
  return { id: fixture.id, pass: reasons.length === 0, reasons };
}

export const STRUCTURAL_FIXTURES: StrictFixture[] = [
  {
    id: "validated-survives",
    answer: "L'article 1104 s'applique.",
    citator:
      "@@CITE status=VALIDATED id=LEGIARTI000032040772 num=1104 version=APPLICABLE@@",
    requiredNums: ["1104"],
  },
  {
    id: "one-bad-cite-fails",
    answer: "L'article 1104 et l'article 1108 s'appliquent.",
    citator:
      "@@CITE status=VALIDATED id=LEGIARTI000032040772 num=1104 version=APPLICABLE@@",
    forbiddenNums: ["1108"],
  },
  {
    id: "prose-validated-is-not-enough",
    answer: "L'article 1108 est cité.",
    citator: "article 1108 VALIDATED LEGIARTI000000000008",
  },
  {
    id: "indisponible-does-not-pass",
    answer: "L'article 1104 au 1er janvier 2010.",
    citator:
      "@@CITE status=VALIDATED id=LEGIARTI000032040772 num=1104 version=INDISPONIBLE@@",
  },
];
