/** Exact source set; this does not authorize a packet or a desktop run. */
export function isFourIncomeSourceSet(value: unknown): value is string[] {
  const expected = ["business", "pension", "salary", "services"];
  return Array.isArray(value) && value.length === 4 &&
    value.every(source => typeof source === "string") &&
    [...value].sort().every((source, index) => source === expected[index]);
}
