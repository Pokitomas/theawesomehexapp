import { projectActiveWeaveState as projectLegacyActiveWeaveState } from './weave-active-state.mjs';
import { canonicalWeaveMessages } from './weave-replay-integrity.mjs';

export function projectActiveWeaveState(messages, options = {}) {
  return projectLegacyActiveWeaveState(canonicalWeaveMessages(messages), options);
}
