import { log } from "@/lib/log";
import { isAbortError } from "./retry";

/**
 * Capture la première erreur fournisseur d'un `streamText`.
 *
 * Quand l'appel échoue après un premier pas réussi (ex. 400 « fenêtre de
 * contexte dépassée » au 12ᵉ pas d'outils), le SDK n'en lève aucune : il
 * ferme le flux et `.text` vaut le texte du dernier pas abouti — vide si ce
 * pas était un appel d'outil. On garde donc l'erreur ici pour que
 * l'orchestrateur la remonte (agent_error) au lieu d'afficher « sortie vide ».
 */
export function createStreamErrorCapture(agent: { role: string; label: string }) {
  let first: unknown;
  let seen = false;
  return {
    onError: ({ error }: { error: unknown }) => {
      // « Stop » utilisateur : ce n'est pas une panne, le tour est déjà
      // annulé proprement en amont.
      if (isAbortError(error)) return;
      if (!seen) {
        seen = true;
        first = error;
      }
      const e = error as { message?: string; statusCode?: number; url?: string };
      log.error("agent-stream", "Échec d'un appel modèle pendant le run", {
        role: agent.role,
        label: agent.label,
        error: error instanceof Error ? error.message : String(error),
        statusCode: e?.statusCode ?? null,
        url: e?.url ?? null,
      });
    },
    get: (): unknown => (seen ? first ?? new Error("Erreur de stream") : undefined),
  };
}
