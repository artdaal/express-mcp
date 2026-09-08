export interface LiveSmokeBounds {
  listCount: number;
  readCount: number;
  listBounded: boolean;
  readBounded: boolean;
}

export function liveSmokeBounds(
  listCount: number,
  listLimit: number,
  readCount: number,
  readLimit: number,
): LiveSmokeBounds {
  return {
    listCount,
    readCount,
    listBounded: listCount <= listLimit,
    readBounded: readCount <= readLimit,
  };
}

export interface LiveSearchSmokeAggregate {
  ok: true;
  selectorVersion: string;
  requestedLimit: number;
  returnedResultCount: number;
  resultCountBounded: boolean;
  truncationReported: boolean;
  allResultsDirect: boolean;
  searchStateCleared: boolean;
}

export function liveSearchSmokeAggregate(options: {
  selectorVersion: string;
  requestedLimit: number;
  returnedResultCount: number;
  truncated: boolean;
  allResultsDirect: boolean;
  searchStateCleared: boolean;
}): LiveSearchSmokeAggregate {
  return {
    ok: true,
    selectorVersion: options.selectorVersion,
    requestedLimit: options.requestedLimit,
    returnedResultCount: options.returnedResultCount,
    resultCountBounded:
      options.returnedResultCount <= options.requestedLimit,
    truncationReported: typeof options.truncated === "boolean",
    allResultsDirect: options.allResultsDirect,
    searchStateCleared: options.searchStateCleared,
  };
}
