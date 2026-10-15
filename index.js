/**
 * Host half of dsh-plugins-custom-enter-key.
 *
 * All state and behavior live in the browser: the client half (exported as
 * "./client") owns both the Settings row and the composer key interception,
 * and persists its configuration in localStorage. The provider row still
 * needs a valid Host module to load, so this half is intentionally empty.
 */

/**
 * Mount the host half.
 * @param ctx - Host context (unused: this half owns no state).
 */
export function apply(_ctx) {}
