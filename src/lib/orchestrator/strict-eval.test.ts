import { describe, expect, it } from "vitest";
import { STRUCTURAL_FIXTURES, gradeAnswer } from "./strict-eval";

describe("gradeAnswer", () => {
  it("laisse passer une fiche dont chaque citation est dans une ligne machine", () => {
    const grade = gradeAnswer(STRUCTURAL_FIXTURES[0]!);
    expect(grade.pass).toBe(true);
  });

  it("fait échouer la fiche dès qu'une citation doit être retirée", () => {
    for (const fixture of STRUCTURAL_FIXTURES.slice(1)) {
      const grade = gradeAnswer(fixture);
      expect(grade.pass, fixture.id).toBe(false);
      expect(grade.reasons[0]).toContain("citation fausse");
    }
  });
});
