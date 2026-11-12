import { describe, it, expect, vi } from "vitest";
import { streamText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";
import { buildPrepareStep, createStepContextGuard } from "./step-context";
import { createStreamErrorCapture } from "./stream-error";

vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Tests contre le VRAI `streamText` (modèle simulé) : ils fixent le
 * comportement du SDK sur lequel reposent la garde de contexte par pas et la
 * remontée d'erreur, pour qu'une montée de version qui le changerait se voie.
 */

type DoStream = NonNullable<
  ConstructorParameters<typeof MockLanguageModelV3>[0]
>["doStream"];
type StreamResult = Awaited<
  ReturnType<Extract<DoStream, (...args: never[]) => unknown>>
>;

const usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

const toolCallStep = (id: string): StreamResult => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "legifrance_get_article",
      input: JSON.stringify({ id }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
    },
  ]),
});

const textStep = (text: string): StreamResult => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
  ]),
});

const ARTICLE_TEXT = "Le contrat est formé par la rencontre d'une offre. ".repeat(120);

const tools = {
  legifrance_get_article: tool({
    description: "Texte officiel d'un article",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => ({
      id: `LEGIARTI${id}`,
      num: "1113",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032040861",
      texte: ARTICLE_TEXT,
    }),
  }),
};

const QUESTION = "Comment se forme un contrat ?";
const messages = [{ role: "user" as const, content: QUESTION }];

describe("erreur fournisseur en cours de run", () => {
  it("le SDK renvoie un texte vide sans lever ; la capture garde l'erreur", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        if (calls <= 2) return toolCallStep(`c${calls}`);
        throw Object.assign(
          new Error("request exceeds the context window: prompt (67876 tokens)"),
          { statusCode: 400 }
        );
      },
    });
    const capture = createStreamErrorCapture({ role: "research", label: "Recherche" });

    const stream = streamText({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(8),
      onError: capture.onError,
      maxRetries: 0,
    });
    await stream.consumeStream();

    // Le piège : aucun rejet, texte du dernier pas abouti (un appel d'outil).
    expect(await stream.text).toBe("");
    expect(calls).toBe(3);

    const failure = capture.get() as Error & { statusCode?: number };
    expect(failure.message).toMatch(/context window/);
    expect(failure.statusCode).toBe(400);
  });

  it("échec dès le premier pas : l'erreur d'origine est capturée aussi", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw Object.assign(new Error("context window exceeded"), {
          statusCode: 400,
        });
      },
    });
    const capture = createStreamErrorCapture({ role: "research", label: "Recherche" });
    const stream = streamText({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(8),
      onError: capture.onError,
      maxRetries: 0,
    });
    await stream.consumeStream();
    // L'orchestrateur relance cette erreur sans lire `.text` (qui, lui,
    // rejetterait avec un « No output generated » moins parlant).
    expect((capture.get() as Error).message).toBe("context window exceeded");
  });

  it("aucune erreur capturée quand le run aboutit", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => (++calls === 1 ? toolCallStep("c1") : textStep("ok")),
    });
    const capture = createStreamErrorCapture({ role: "research", label: "Recherche" });
    const stream = streamText({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(8),
      onError: capture.onError,
    });
    await stream.consumeStream();
    expect(await stream.text).toBe("ok");
    expect(capture.get()).toBeUndefined();
  });
});

describe("garde de contexte par pas, de bout en bout", () => {
  it("compacte ce qui est envoyé au modèle puis le fait conclure avant la fenêtre", async () => {
    const maxSteps = 24;
    const windowTokens = 4000;
    // Un modèle qui appellerait des outils indéfiniment si on le laissait faire.
    let n = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) =>
        options.toolChoice?.type === "none"
          ? textStep("Synthèse fondée sur les articles obtenus.")
          : toolCallStep(`c${++n}`),
    });

    const stream = streamText({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(maxSteps),
      prepareStep: buildPrepareStep({
        maxSteps,
        guard: createStepContextGuard({
          role: "research",
          label: "Recherche",
          systemChars: 0,
          toolCount: 1,
          windowTokens,
        }),
      }),
    });
    await stream.consumeStream();

    expect(await stream.text).toBe("Synthèse fondée sur les articles obtenus.");

    const sent = model.doStreamCalls;
    // Conclusion provoquée par la garde, bien avant le dernier pas autorisé.
    expect(sent.length).toBeGreaterThan(3);
    expect(sent.length).toBeLessThan(maxSteps);
    expect(sent[sent.length - 1].toolChoice).toEqual({ type: "none" });

    for (const callOptions of sent) {
      const serialized = JSON.stringify(callOptions.prompt);
      // Au ratio par défaut (3 caractères par token), sous la fenêtre.
      expect(serialized.length / 3).toBeLessThan(windowTokens);
      // La question reste toujours en tête.
      expect(serialized).toContain(QUESTION);
    }

    const last = JSON.stringify(sent[sent.length - 1].prompt);
    expect(last).toContain("tronqué");
    // Les identifiants et l'URL survivent au compactage.
    expect(last).toContain("LEGIARTIc1");
    expect(last).toContain("LEGIARTI000032040861");

    // Le compactage ne s'applique qu'à l'envoi : l'historique du run garde
    // les résultats d'outils complets.
    const steps = await stream.steps;
    const firstResult = steps[0].toolResults[0];
    expect(JSON.stringify(firstResult.output)).toContain(ARTICLE_TEXT);
  });

  it("sans fenêtre déclarée : comportement d'origine (conclusion au dernier pas)", async () => {
    const maxSteps = 4;
    let n = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) =>
        options.toolChoice?.type === "none"
          ? textStep("fin")
          : toolCallStep(`c${++n}`),
    });
    const stream = streamText({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(maxSteps),
      prepareStep: buildPrepareStep({
        maxSteps,
        guard: createStepContextGuard({
          role: "research",
          label: "Recherche",
          systemChars: 0,
          toolCount: 1,
          windowTokens: null,
        }),
      }),
    });
    await stream.consumeStream();

    expect(await stream.text).toBe("fin");
    expect(model.doStreamCalls).toHaveLength(maxSteps);
    expect(JSON.stringify(model.doStreamCalls[3].prompt)).not.toContain("tronqué");
  });
});
