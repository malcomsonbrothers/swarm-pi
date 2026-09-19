/**
 * Capabilities this build advertises through `pi --capabilities`, one name per
 * line. A driver (the swarm daemon) reads the list to tell what the pi on its
 * PATH can do before it drives it, without loading a model or a session.
 *
 * Names are stable once published. Add a new name rather than change one.
 */
export const CAPABILITIES: readonly string[] = [
	// Print mode finishes the turn in flight on SIGUSR2 and exits 0.
	"graceful-turn-exit",
	// ~/.pi/agent/codex-service-tier needs the full consent sentence for "priority".
	"codex-service-tier-consent",
	// `--mode json` streams one JSON event per line.
	"print-mode-json-events",
];

/** The exact text `pi --capabilities` prints. */
export function formatCapabilities(): string {
	return `${CAPABILITIES.join("\n")}\n`;
}
