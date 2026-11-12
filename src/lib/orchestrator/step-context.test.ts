import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
  COMPACTION_LEVELS,
  buildPrepareStep,
  compactToolResults,
  createStepContextGuard,
  planStepContext,
} from "./step-context";

vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const user = (content: string): ModelMessage => ({ role: "user", content });

const call = (id: string, toolName: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input: { id } }],
});

const result = (id: string, toolName: string, value: unknown): ModelMessage =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName,
        output: { type: "json", value },
      },
    ],
  }) as ModelMessage;

const prose = (n: number) => "mot ".repeat(Math.ceil(n / 4)).slice(0, n);

const ARTICLE_URL =
  "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032041473";

const article = (n: number, textLen = 3000) => ({
  id: `LEGIARTI0000320414${String(n).padStart(2, "0")}`,
  num: `12${n}`,
  codeTitle: "Code civil",
  etat: "VIGUEUR",
  url: ARTICLE_URL,
  texte: prose(textLen),
});

/** 8 résultats de 700 caractères : la forme réelle de legifrance_search. */
const searchHits = (n: number) =>
  Array.from({ length: 8 }, (_, i) => ({
    id: `LEGIARTI00000${n}${i}`,
    title: `Article ${n}-${i}`,
    url: ARTICLE_URL,
    excerpt: prose(700),
  }));

/** Question + `steps` pas d'outils (`perStep` appels en parallèle par pas). */
function researchRun(steps: number, perStep = 1): ModelMessage[] {
  const msgs: ModelMessage[] = [user("Quelles règles pour un contrat SaaS B2B ?")];
  for (let s = 0; s < steps; s++) {
    const ids = Array.from({ length: perStep }, (_, i) => `c${s}_${i}`);
    msgs.push({
      role: "assistant",
      content: ids.map((id) => ({
        type: "tool-call" as const,
        toolCallId: id,
        toolName: "legifrance_search",
        input: { query: id },
      })),
    });
    for (const id of ids) {
      msgs.push(result(id, "legifrance_search", searchHits(s)));
    }
  }
  return msgs;
}

function toolOutputs(messages: ModelMessage[]) {
  return messages.flatMap((m) =>
    m.role === "tool"
      ? m.content.flatMap((p) => (p.type === "tool-result" ? [p.output] : []))
      : []
  );
}

describe("compactToolResults", () => {
  const msgs = [
    user("question"),
    call("c1", "legifrance_get_article"),
    result("c1", "legifrance_get_article", article(1)),
    call("c2", "legifrance_get_article"),
    result("c2", "legifrance_get_article", article(2)),
  ];

  it("ne supprime aucun message et garde la question", () => {
    const out = compactToolResults(msgs, 3);
    expect(out).toHaveLength(msgs.length);
    expect(out[0]).toBe(msgs[0]);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
  });

  it("raccourcit la prose des anciens résultats, pas les identifiants ni les URL", () => {
    const [old] = toolOutputs(compactToolResults(msgs, 1));
    if (old.type !== "json") throw new Error("json attendu");
    const value = old.value as ReturnType<typeof article>;
    expect(value.id).toBe("LEGIARTI000032041401");
    expect(value.num).toBe("121");
    expect(value.url).toBe(ARTICLE_URL);
    expect(value.texte.length).toBeLessThan(500);
    expect(value.texte).toContain("tronqué");
  });

  it("niveau 1 : le résultat du dernier pas reste intact", () => {
    const out = compactToolResults(msgs, 1);
    expect(out[4]).toBe(msgs[4]);
  });

  it("niveaux suivants : le dernier pas est raccourci, mais moins que les anciens", () => {
    const [old, recent] = toolOutputs(compactToolResults(msgs, 3));
    expect(JSON.stringify(recent).length).toBeLessThan(
      JSON.stringify(toolOutputs(msgs)[1]).length
    );
    expect(JSON.stringify(recent).length).toBeGreaterThan(
      JSON.stringify(old).length
    );
  });

  it("plafonne la taille totale d'un résultat encore trop gros", () => {
    const out = compactToolResults(
      [
        user("q"),
        call("c1", "legifrance_search"),
        result("c1", "legifrance_search", searchHits(1)),
        call("c2", "legifrance_search"),
        result("c2", "legifrance_search", searchHits(2)),
      ],
      3
    );
    const [old] = toolOutputs(out);
    expect(old.type).toBe("text");
    expect(JSON.stringify(old).length).toBeLessThan(
      COMPACTION_LEVELS[2].old.total + 100
    );
  });

  it("garde chaque résultat apparié à son appel", () => {
    const out = compactToolResults(researchRun(6, 3), 3);
    const calls = new Set<string>();
    for (const m of out) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "tool-call") calls.add(p.toolCallId);
        }
      }
      if (m.role === "tool") {
        for (const p of m.content) {
          if (p.type === "tool-result") {
            expect(calls.has(p.toolCallId)).toBe(true);
          }
        }
      }
    }
    expect(calls.size).toBe(18);
  });

  it("niveau inconnu : messages inchangés", () => {
    expect(compactToolResults(msgs, 0)).toBe(msgs);
  });
});

describe("planStepContext", () => {
  const base = { windowTokens: 65_536, systemChars: 3000, toolCount: 5 };

  it("sous le seuil : ne touche à rien", () => {
    const plan = planStepContext({
      ...base,
      messages: researchRun(2),
      stepNumber: 2,
    });
    expect(plan.messages).toBeUndefined();
    expect(plan.forceText).toBe(false);
    expect(plan.level).toBe(0);
  });

  it("au-dessus du seuil : compacte et laisse l'agent continuer", () => {
    const messages = researchRun(20);
    const plan = planStepContext({ ...base, messages, stepNumber: 20 });
    expect(plan.rawEstimatedTokens).toBeGreaterThan(plan.limitTokens * 0.7);
    expect(plan.level).toBeGreaterThan(0);
    expect(plan.messages).toHaveLength(messages.length);
    expect(plan.estimatedTokens).toBeLessThan(plan.rawEstimatedTokens);
    expect(plan.forceText).toBe(false);
  });

  it("quand le compactage ne suffit plus : retire les outils", () => {
    const plan = planStepContext({
      ...base,
      windowTokens: 8192,
      messages: researchRun(12, 4),
      stepNumber: 12,
    });
    expect(plan.forceText).toBe(true);
  });

  it("au premier pas : ne retire jamais les outils", () => {
    const plan = planStepContext({
      ...base,
      windowTokens: 8192,
      messages: [user(prose(60_000))],
      stepNumber: 0,
    });
    expect(plan.forceText).toBe(false);
  });

  it("conclut avec le compactage le plus léger qui tient", () => {
    // Gros historique incompressible : aucun niveau ne repasse sous le seuil
    // « continuer », mais les messages bruts tiennent pour une conclusion.
    const messages = [
      user(prose(125_000)),
      ...researchRun(1).slice(1),
    ];
    const plan = planStepContext({ ...base, messages, stepNumber: 1 });
    expect(plan.forceText).toBe(true);
    expect(plan.level).toBe(0);
    expect(plan.messages).toBeUndefined();
    expect(plan.estimatedTokens).toBeLessThanOrEqual(plan.limitTokens * 0.9);
  });

  it.each([
    ["un appel par pas", 1],
    ["six appels parallèles par pas", 6],
  ])(
    "run Recherche de 23 pas (%s) : le prompt estimé ne dépasse jamais le plafond",
    (_name, perStep) => {
      for (let step = 1; step <= 23; step++) {
        const plan = planStepContext({
          ...base,
          messages: researchRun(step, perStep),
          stepNumber: step,
        });
        expect(plan.estimatedTokens).toBeLessThanOrEqual(plan.limitTokens);
      }
    }
  );
});

describe("createStepContextGuard", () => {
  const opts = { role: "research", label: "Recherche", systemChars: 3000, toolCount: 5 };

  it("inactif sans fenêtre déclarée", () => {
    const guard = createStepContextGuard({ ...opts, windowTokens: null });
    expect(guard({ messages: researchRun(23, 6), stepNumber: 23, steps: [] })).toBeNull();
  });

  it("recale le ratio caractères/token sur la mesure du fournisseur", () => {
    const messages = researchRun(4);
    const next = researchRun(5);

    const blind = createStepContextGuard({ ...opts, windowTokens: 65_536 });
    blind({ messages, stepNumber: 4, steps: [] });
    const unmeasured = blind({ messages: next, stepNumber: 5, steps: [{}] });

    // Le fournisseur a compté bien plus de tokens que l'estimation à 3 c/t.
    const calibrated = createStepContextGuard({ ...opts, windowTokens: 65_536 });
    const first = calibrated({ messages, stepNumber: 4, steps: [] });
    const measured = calibrated({
      messages: next,
      stepNumber: 5,
      steps: [{ usage: { inputTokens: first!.estimatedTokens * 1.4 } }],
    });

    expect(measured!.rawEstimatedTokens).toBeGreaterThan(
      unmeasured!.rawEstimatedTokens * 1.3
    );
  });

  it("borne le ratio quand la mesure est aberrante", () => {
    const guard = createStepContextGuard({ ...opts, windowTokens: 65_536 });
    const messages = researchRun(4);
    const first = guard({ messages, stepNumber: 4, steps: [] });
    const second = guard({
      messages,
      stepNumber: 5,
      steps: [{ usage: { inputTokens: 1_000_000 } }],
    });
    // Plancher 2 c/t : au pire 1,5× l'estimation par défaut (3 c/t).
    expect(second!.rawEstimatedTokens).toBeLessThanOrEqual(
      first!.rawEstimatedTokens * 1.5 + 1
    );
  });
});

describe("buildPrepareStep", () => {
  const noGuard = () => null;

  it("sans garde : conclusion textuelle au dernier pas seulement", () => {
    const prepare = buildPrepareStep({ maxSteps: 3, guard: noGuard });
    expect(prepare({ messages: [], stepNumber: 0, steps: [] })).toEqual({});
    expect(prepare({ messages: [], stepNumber: 1, steps: [] })).toEqual({});
    expect(prepare({ messages: [], stepNumber: 2, steps: [] })).toEqual({
      toolChoice: "none",
    });
  });

  it("applique les messages compactés et la conclusion demandés par la garde", () => {
    const compacted = [user("x")];
    const prepare = buildPrepareStep({
      maxSteps: 24,
      guard: () => ({
        messages: compacted,
        forceText: true,
        level: 2,
        estimatedTokens: 1,
        rawEstimatedTokens: 2,
        limitTokens: 3,
      }),
    });
    expect(prepare({ messages: [], stepNumber: 5, steps: [] })).toEqual({
      messages: compacted,
      toolChoice: "none",
    });
  });
});
