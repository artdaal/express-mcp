import {
  isSupportedActiveSearchSnapshot,
  type PageSignatureSnapshot,
} from "./selectors/express-web-3.66.js";

export type SearchSettlementTracker =
  | { kind: "unsettled" }
  | {
      kind: "observing";
      terminalKey: string;
      firstObservedAtMs: number;
      observations: number;
    };

export interface SearchSettlementObservation {
  tracker: SearchSettlementTracker;
  terminalKey: string | undefined;
  settled: boolean;
}

export function searchTerminalStateKey(
  snapshot: PageSignatureSnapshot,
): string | undefined {
  if (!isSupportedActiveSearchSnapshot(snapshot)) {
    return undefined;
  }
  if (snapshot.directResultRows > 0) {
    return `direct:${snapshot.directResultRows}`;
  }
  if (snapshot.searchEmptyStates > 0) {
    return `empty:${snapshot.searchEmptyStates}:${snapshot.chatRows}`;
  }
  if (snapshot.chatRows > 0) {
    return `non-direct:${snapshot.chatRows}`;
  }
  return undefined;
}

export function observeSearchSettlement(
  tracker: SearchSettlementTracker,
  snapshot: PageSignatureSnapshot,
  observedAtMs: number,
  minimumGraceMs: number,
  stabilityMs: number,
): SearchSettlementObservation {
  const terminalKey = searchTerminalStateKey(snapshot);
  if (!terminalKey) {
    return {
      tracker: { kind: "unsettled" },
      terminalKey: undefined,
      settled: false,
    };
  }

  const nextTracker =
    tracker.kind === "observing" &&
    tracker.terminalKey === terminalKey
      ? {
          ...tracker,
          observations: tracker.observations + 1,
        }
      : {
          kind: "observing" as const,
          terminalKey,
          firstObservedAtMs: observedAtMs,
          observations: 1,
        };
  return {
    tracker: nextTracker,
    terminalKey,
    settled:
      observedAtMs >= minimumGraceMs &&
      nextTracker.observations >= 2 &&
      observedAtMs - nextTracker.firstObservedAtMs >= stabilityMs,
  };
}
