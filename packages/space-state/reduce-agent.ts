// An agent's live run status.
//
// Volatile, like relayed frames: it appears in neither the full state nor the
// chat history, so a client that joins late or reloads simply starts with
// nothing and fills in as frames arrive.
//
// The whole difficulty here is ordering. Frames can be reordered in transit,
// so a run's `idle` may arrive before a `working` frame it should have ended,
// and one agent's runs follow each other closely enough that a late frame from
// run A can land in the middle of run B. `requestId` is what distinguishes
// them, and both guards below turn on it.

import type { SpaceEffect } from './effects.ts';
import type { AgentStatusMessage } from './messages.ts';
import type { ReduceResult } from './reduce-space.ts';
import { AGENT_ENDED_RUNS_MAX, type SpaceState } from './state.ts';

export function onAgentStatus(state: SpaceState, msg: AgentStatusMessage): ReduceResult {
  const { agentId, requestId, phase } = msg;
  const effects: SpaceEffect[] = [];
  // A non-idle frame from a run that already finished would bring its status
  // back from the dead.
  if (phase !== 'idle' && state.endedAgentRuns.includes(requestId)) return { state, effects };

  if (phase === 'idle') {
    effects.push({ type: 'agent-timer-clear', requestId });
    // FIFO: keep insertion order, drop the oldest once over the cap.
    let endedAgentRuns = state.endedAgentRuns;
    if (!endedAgentRuns.includes(requestId)) {
      endedAgentRuns = [...endedAgentRuns, requestId];
      if (endedAgentRuns.length > AGENT_ENDED_RUNS_MAX) {
        endedAgentRuns = endedAgentRuns.slice(endedAgentRuns.length - AGENT_ENDED_RUNS_MAX);
      }
    }
    // ⚠ **Only clear the status if this is still that agent's current run.**
    //   With run A followed by run B, a late `idle` from A would otherwise
    //   wipe out B's live status.
    let agentStatuses = state.agentStatuses;
    if (state.agentStatuses[agentId]?.requestId === requestId) {
      agentStatuses = { ...state.agentStatuses };
      delete agentStatuses[agentId];
    }
    return { state: { ...state, endedAgentRuns, agentStatuses }, effects };
  }

  // Backstop, in case the `idle` never comes. It has to fire *later* than the
  // host's own run deadline — see `AGENT_STATUS_TIMEOUT_MS`, and note that
  // shortening it would clear the status of a run that is still going fine.
  effects.push({ type: 'agent-timer-clear', requestId });
  effects.push({ type: 'agent-timer', agentId, requestId });
  const agentStatuses = {
    ...state.agentStatuses,
    [agentId]: { requestId, phase, tool: msg.tool },
  };
  return { state: { ...state, agentStatuses }, effects };
}
