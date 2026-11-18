// Counters and gauges of THIS process: what the database cannot know (event
// stream connections, refused requests). Everything that is a fact of a case
// is counted from the records instead (OperationsStore.readMetrics), so it
// survives a restart and cannot drift from what happened.

export interface ProcessMetrics {
  readonly count: (name: string, by?: number) => void;
  readonly gauge: (name: string, delta: number) => void;
  readonly snapshot: () => Record<string, number>;
}

export function createProcessMetrics(): ProcessMetrics {
  const values = new Map<string, number>();
  const add = (name: string, by: number) => values.set(name, (values.get(name) ?? 0) + by);
  return {
    count: (name, by = 1) => add(name, by),
    gauge: (name, delta) => add(name, delta),
    snapshot: () => Object.fromEntries([...values.entries()].sort()),
  };
}
