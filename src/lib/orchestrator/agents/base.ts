import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  type ToolSet,
} from "ai";
import { loadProviderKey, modelFromKey } from "@/lib/providers/factory";
import { instrumentTools } from "@/lib/observability/tools";
import { withApprovalGates } from "@/lib/ai/approval";
import { loadAgentCatalogue } from "../tool-catalogue";
import { composeSystem, filterTools } from "./default";
import { injectUntrustedContext } from "../untrusted";
import { applyContextBudget } from "../context-budget";
import { buildPrepareStep, createStepContextGuard } from "../step-context";
import { createStreamErrorCapture } from "../stream-error";
import { applyCachedSystem } from "../provider-tuning";
import { resolveAgentRag, omitDocumentaryRagTools } from "./rag-scope";
import type {
  AgentContext,
  AgentDefinition,
  AgentRunResult,
} from "../types";

/**
 * Configuration « factory » d'un rôle d'agent. Chaque agent dédié
 * (Research, Citator, Reviewer, Orchestrator) déclare ses defaults — qui
 * peuvent toujours être overridés par l'utilisateur via l'UI /board
 * (champ systemPrompt, toolAllowlist sur pipeline_agents).
 */
export interface AgentFactoryDefaults {
  systemPrompt: string;
  /**
   * null → tous les outils (comme DefaultAgent).
   * []   → aucun outil (l'agent travaille uniquement sur le texte).
   * [...]→ sous-ensemble explicite (à n'autoriser que ce qui sert au rôle).
   */
  toolAllowlist: string[] | null;
  /** stepCountIs — par défaut 3 pour les agents spécialisés. */
  maxSteps?: number;
}

/**
 * Exécute un agent générique : charge la clé, monte le modèle, applique
 * le system prompt composé et lance streamText. Mutualisé entre tous les
 * agents pour garantir une exécution homogène (gestion d'outils, gestion
 * du provider, etc.) sans dupliquer le boilerplate.
 */
export async function runAgentStream(
  def: AgentDefinition,
  ctx: AgentContext,
  defaults: AgentFactoryDefaults
): Promise<AgentRunResult> {
  const key = await loadProviderKey(ctx.userId, def.providerKeyId);
  const model = modelFromKey(key, def.modelOverride);
  const modelMessages = applyContextBudget(
    injectUntrustedContext(await convertToModelMessages(ctx.messages), ctx)
  );

  const system = composeSystem(defaults.systemPrompt, def, ctx);

  // Le toolAllowlist côté définition utilisateur a la priorité sur le
  // default du rôle (un utilisateur peut élargir l'allowlist d'un agent
  // dans /board).
  const allowlist =
    def.toolAllowlist !== undefined && def.toolAllowlist !== null
      ? def.toolAllowlist
      : defaults.toolAllowlist;

  let tools: ToolSet = {};
  if (allowlist === null || (allowlist && allowlist.length > 0)) {
    const { scope, hideDocumentaryRag } = await resolveAgentRag(
      ctx,
      def.ragScope
    );
    const { connectorTools, mcpTools } = await loadAgentCatalogue(
      ctx.userId,
      scope,
      ctx.toolCatalogue
    );
    let merged: ToolSet = { ...connectorTools, ...mcpTools };
    if (hideDocumentaryRag) merged = omitDocumentaryRagTools(merged);
    tools = withApprovalGates(
      instrumentTools(filterTools(merged, allowlist), ctx.userId),
      ctx.requestToolApproval
    );
  }

  // Outils injectés par l'orchestrateur (mode maestro : les agents de
  // l'équipe). Hors allowlist et hors instrumentation : leur execute émet
  // déjà les événements agent_start/finish vers l'UI et l'audit.
  if (ctx.extraTools) {
    tools = { ...tools, ...ctx.extraTools };
  }

  // Même contrat que runDefaultAgent : au dernier pas, retirer les outils
  // pour forcer une conclusion textuelle (sinon le citateur peut brûler
  // tout son budget en appels Légifrance et finir avec une sortie vide).
  const maxSteps = ctx.maxStepsOverride ?? defaults.maxSteps ?? 3;

  const cached = applyCachedSystem({
    keyType: key.type,
    system,
    messages: modelMessages,
    hasTools: Object.keys(tools).length > 0,
  });

  // Garde de contexte par pas : inactive tant que
  // LOUIS_CONTEXT_WINDOW_TOKENS n'est pas défini (cf. step-context.ts).
  const guard = createStepContextGuard({
    role: def.role,
    label: def.label,
    systemChars: cached.system?.length ?? 0,
    toolCount: Object.keys(tools).length,
  });
  const streamError = createStreamErrorCapture(def);
  // Dernier pas (ou garde de contexte) : conclusion textuelle obligatoire.
  const prepareBase = buildPrepareStep({ maxSteps, guard });

  const toolNames = Object.keys(tools);
  const forceToolsOnFirstStep =
    toolNames.length > 0 &&
    (def.role === "citator" ||
      def.role === "research" ||
      def.role === "legifrance");

  const stream = streamText({
    model,
    system: cached.system,
    messages: cached.messages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    prepareStep: (step) => {
      const prepared = prepareBase(step);
      // Premier pas Recherche/Citateur : forcer un vrai tool-call natif
      // (évite le XML `<tool_call>` collé en prose par certains modèles).
      if (
        forceToolsOnFirstStep &&
        step.stepNumber === 0 &&
        prepared.toolChoice === undefined
      ) {
        return { ...prepared, toolChoice: "required" as const };
      }
      return prepared;
    },
    onError: streamError.onError,
    temperature: def.temperature ?? undefined,
    abortSignal: ctx.abortSignal,
  });

  return { kind: "stream", stream, streamError: streamError.get };
}
