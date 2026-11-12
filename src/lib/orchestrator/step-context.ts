import type { ModelMessage } from "ai";
import { log } from "@/lib/log";
import { messageChars, resolveContextWindowTokens } from "./context-budget";

/**
 * Garde de contexte PAR PAS.
 *
 * `applyContextBudget` ne rogne que l'historique AVANT le premier appel. Or un
 * agent à outils (Recherche, Citateur…) empile ensuite ses résultats d'outils
 * pas après pas : sur un modèle local à petite fenêtre, le Nᵉ appel dépasse la
 * fenêtre, le fournisseur répond 400 et l'agent finit sans texte.
 *
 * Quand `LOUIS_CONTEXT_WINDOW_TOKENS` est défini, on intervient à chaque pas :
 *  1. on COMPACTE les résultats d'outils (jamais la question ni les paires
 *     appel/résultat, donc pas d'orphelin côté API) ;
 *  2. si cela ne suffit plus, on retire les outils pour ce pas : le modèle
 *     rédige avec ce qu'il a, au lieu d'échouer au pas suivant.
 *
 * Sans la variable, rien ne change (modèles hébergés à grande fenêtre).
 *
 * Le SDK reconstruit les messages de chaque pas à partir de l'historique
 * complet : le compactage est donc recalculé à chaque fois sur les résultats
 * d'origine, il ne se cumule pas.
 */

const TRUNCATED = "…[tronqué : contexte limité]";

/** Part de la fenêtre réservée à la réponse du modèle. */
const OUTPUT_RESERVE_FRACTION = 0.12;
const MIN_OUTPUT_RESERVE_TOKENS = 1024;
/** Sous ce taux de remplissage, l'agent peut encore appeler des outils. */
const CONTINUE_FRACTION = 0.7;
/** Taux maximal accepté pour le pas de conclusion (plus rien ne s'ajoute). */
const CONCLUDE_FRACTION = 0.9;
/** Coût forfaitaire d'un schéma d'outil (non visible dans les messages). */
const TOOL_SCHEMA_TOKENS = 300;

/**
 * Ratio caractères/token utilisé tant que le fournisseur n'a rien mesuré.
 * Volontairement plus prudent que le « 4 » de l'estimation de coût : le texte
 * juridique français et le JSON des outils consomment plus de tokens.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3;
const MIN_CHARS_PER_TOKEN = 2;
const MAX_CHARS_PER_TOKEN = 4.5;

interface Caps {
  /** Longueur max d'une chaîne de prose (contenant des espaces). */
  prose: number;
  /** Longueur max du résultat sérialisé. */
  total: number;
}

interface Level {
  /** Résultats des pas précédents (déjà lus par le modèle). */
  old: Caps;
  /** Résultats du dernier pas (pas encore lus) ; null = intacts. */
  recent: Caps | null;
}

export const COMPACTION_LEVELS: readonly Level[] = [
  { old: { prose: 400, total: 2400 }, recent: null },
  { old: { prose: 160, total: 1200 }, recent: { prose: 2500, total: 8000 } },
  { old: { prose: 80, total: 600 }, recent: { prose: 800, total: 3000 } },
];

/**
 * Raccourcit les chaînes de PROSE (celles qui contiennent une espace). Les
 * identifiants, numéros et URL (sans espace) sont conservés intacts : ce sont
 * eux que l'agent doit pouvoir recopier (LEGIARTI…, lien Légifrance).
 */
function shortenProse(value: unknown, maxProse: number): unknown {
  if (typeof value === "string") {
    return value.length > maxProse && /\s/.test(value)
      ? value.slice(0, maxProse) + TRUNCATED
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => shortenProse(v, maxProse));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, shortenProse(v, maxProse)])
    );
  }
  return value;
}

type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolPart = ToolMessage["content"][number];
type ToolResultPart = Extract<ToolPart, { type: "tool-result" }>;

function compactOutput(
  output: ToolResultPart["output"],
  caps: Caps
): ToolResultPart["output"] {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value.length > caps.total
        ? { ...output, value: output.value.slice(0, caps.total) + TRUNCATED }
        : output;
    case "json":
    case "error-json": {
      const shortened = shortenProse(output.value, caps.prose);
      const serialized = JSON.stringify(shortened) ?? "";
      if (serialized.length <= caps.total) {
        return { ...output, value: shortened as typeof output.value };
      }
      // Encore trop gros : on bascule en texte brut tronqué (le fournisseur
      // sérialise de toute façon le résultat en chaîne).
      return {
        type: output.type === "json" ? "text" : "error-text",
        value: serialized.slice(0, caps.total) + TRUNCATED,
      };
    }
    default:
      return output;
  }
}

function compactToolMessage(m: ToolMessage, caps: Caps): ToolMessage {
  return {
    ...m,
    content: m.content.map((part) =>
      part.type === "tool-result"
        ? { ...part, output: compactOutput(part.output, caps) }
        : part
    ),
  };
}

/**
 * Compacte les résultats d'outils selon `level` (1..COMPACTION_LEVELS.length).
 * Les messages `tool` en fin de liste sont ceux du dernier pas : le modèle ne
 * les a pas encore lus, ils sont donc moins (ou pas) raccourcis. Aucun message
 * n'est supprimé.
 */
export function compactToolResults(
  messages: ModelMessage[],
  level: number
): ModelMessage[] {
  const spec = COMPACTION_LEVELS[level - 1];
  if (!spec) return messages;

  let firstRecent = messages.length;
  while (firstRecent > 0 && messages[firstRecent - 1].role === "tool") {
    firstRecent--;
  }

  return messages.map((m, i) => {
    if (m.role !== "tool") return m;
    const caps = i >= firstRecent ? spec.recent : spec.old;
    return caps ? compactToolMessage(m, caps) : m;
  });
}

export interface StepContextPlan {
  /** Messages compactés à envoyer pour ce pas ; absent = messages intacts. */
  messages?: ModelMessage[];
  /** true → retirer les outils pour ce pas (conclusion textuelle). */
  forceText: boolean;
  /** 0 = intact, sinon niveau de compactage appliqué. */
  level: number;
  /** Estimation (tokens) de ce qui est réellement envoyé. */
  estimatedTokens: number;
  /** Estimation (tokens) avant compactage. */
  rawEstimatedTokens: number;
  /** Plafond du prompt : fenêtre moins la réserve de sortie. */
  limitTokens: number;
}

export function planStepContext(opts: {
  messages: ModelMessage[];
  stepNumber: number;
  windowTokens: number;
  /** Caractères du prompt système quand il n'est pas dans `messages`. */
  systemChars: number;
  toolCount: number;
  charsPerToken?: number;
}): StepContextPlan {
  const { messages, stepNumber, windowTokens, systemChars, toolCount } = opts;
  const charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

  const reserve = Math.max(
    MIN_OUTPUT_RESERVE_TOKENS,
    Math.round(windowTokens * OUTPUT_RESERVE_FRACTION)
  );
  const limitTokens = Math.max(1, windowTokens - reserve);
  const continueLimit = Math.floor(limitTokens * CONTINUE_FRACTION);
  const concludeLimit = Math.floor(limitTokens * CONCLUDE_FRACTION);

  const estimate = (msgs: ModelMessage[]): number =>
    Math.ceil((systemChars + totalChars(msgs)) / charsPerToken) +
    toolCount * TOOL_SCHEMA_TOKENS;

  const lastLevel = COMPACTION_LEVELS.length;
  const cache = new Map<number, { messages: ModelMessage[]; tokens: number }>();
  const at = (level: number) => {
    let entry = cache.get(level);
    if (!entry) {
      const msgs = level === 0 ? messages : compactToolResults(messages, level);
      entry = { messages: msgs, tokens: estimate(msgs) };
      cache.set(level, entry);
    }
    return entry;
  };

  const rawEstimatedTokens = at(0).tokens;
  const plan = (level: number, forceText: boolean): StepContextPlan => ({
    messages: level === 0 ? undefined : at(level).messages,
    forceText,
    level,
    estimatedTokens: at(level).tokens,
    rawEstimatedTokens,
    limitTokens,
  });

  // Premier pas : rien n'a encore été appelé. On compacte au besoin les
  // résultats d'outils hérités de l'historique, mais on ne retire jamais les
  // outils — un agent de recherche sans outil répondrait de mémoire.
  if (stepNumber === 0) {
    for (let level = 0; level <= lastLevel; level++) {
      if (at(level).tokens <= continueLimit) return plan(level, false);
    }
    return plan(lastLevel, false);
  }

  // Pas suivants : tant qu'un compactage modéré laisse de la marge, l'agent
  // continue d'appeler des outils.
  for (let level = 0; level < lastLevel; level++) {
    if (at(level).tokens <= continueLimit) return plan(level, false);
  }

  // Plus de marge : conclure maintenant, avec le compactage le plus léger qui
  // tient (le pas de conclusion n'ajoute plus de résultat d'outil).
  for (let level = 0; level <= lastLevel; level++) {
    if (at(level).tokens <= concludeLimit) return plan(level, true);
  }
  return plan(lastLevel, true);
}

function totalChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += messageChars(m);
  return chars;
}

interface StepLike {
  usage?: { inputTokens?: number | undefined } | undefined;
}

export interface StepGuardArgs {
  messages: ModelMessage[];
  stepNumber: number;
  steps: readonly StepLike[];
}

/**
 * Garde à état pour UN run d'agent. Après chaque pas, le fournisseur renvoie
 * le nombre réel de tokens du prompt : on s'en sert pour recaler le ratio
 * caractères/token au lieu de se fier à une constante.
 *
 * Renvoie null quand `LOUIS_CONTEXT_WINDOW_TOKENS` n'est pas défini.
 */
export function createStepContextGuard(opts: {
  role: string;
  label: string;
  systemChars: number;
  toolCount: number;
  /** Surcharge de test ; par défaut lu dans l'environnement. */
  windowTokens?: number | null;
}): (args: StepGuardArgs) => StepContextPlan | null {
  const windowTokens =
    opts.windowTokens === undefined
      ? resolveContextWindowTokens()
      : opts.windowTokens;
  if (!windowTokens) return () => null;

  const schemaTokens = opts.toolCount * TOOL_SCHEMA_TOKENS;
  let charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  let lastSentChars: number | null = null;

  return ({ messages, stepNumber, steps }) => {
    const measured = steps[steps.length - 1]?.usage?.inputTokens;
    if (measured && lastSentChars && measured > schemaTokens) {
      charsPerToken = Math.min(
        MAX_CHARS_PER_TOKEN,
        Math.max(MIN_CHARS_PER_TOKEN, lastSentChars / (measured - schemaTokens))
      );
    }

    const plan = planStepContext({
      messages,
      stepNumber,
      windowTokens,
      systemChars: opts.systemChars,
      toolCount: opts.toolCount,
      charsPerToken,
    });
    lastSentChars = opts.systemChars + totalChars(plan.messages ?? messages);

    const meta = {
      role: opts.role,
      label: opts.label,
      step: stepNumber,
      messages: messages.length,
      estimatedTokens: plan.estimatedTokens,
      rawEstimatedTokens: plan.rawEstimatedTokens,
      limitTokens: plan.limitTokens,
      windowTokens,
      previousInputTokens: measured ?? null,
      charsPerToken: Math.round(charsPerToken * 100) / 100,
      compaction: plan.level,
      forceText: plan.forceText,
    };
    if (plan.estimatedTokens > plan.limitTokens) {
      log.warn(
        "agent-context",
        "Prompt estimé au-dessus de la fenêtre malgré le compactage",
        meta
      );
    } else {
      log.info("agent-context", "Contexte du pas", meta);
    }
    return plan;
  };
}

/**
 * `prepareStep` commun aux agents : conclusion textuelle au dernier pas
 * (contrat existant) ou dès que la garde de contexte le demande, et messages
 * compactés quand la garde en fournit.
 */
export function buildPrepareStep(opts: {
  maxSteps: number;
  guard: (args: StepGuardArgs) => StepContextPlan | null;
}) {
  return (args: StepGuardArgs) => {
    const plan = opts.guard(args);
    const lastStep = args.stepNumber >= opts.maxSteps - 1;
    return {
      ...(plan?.messages ? { messages: plan.messages } : {}),
      ...(lastStep || plan?.forceText ? { toolChoice: "none" as const } : {}),
    };
  };
}
