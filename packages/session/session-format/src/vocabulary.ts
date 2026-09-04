/**
 * Combine the installed event vocabularies admitted by one format operation.
 * @module @deepseek-ai/dsh-session-format/vocabulary
 */

/**
 * Union the static catalog vocabulary with one call-time dynamic set.
 * @param staticTypes - vocabulary supplied at catalog construction; may be undefined.
 * @param dynamicTypes - vocabulary supplied at one read; may be undefined.
 * @returns the merged set, the single present set, or undefined when neither is present.
 */
export function unionSessionFormatEventTypes(
  staticTypes: ReadonlySet<string> | undefined,
  dynamicTypes: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (staticTypes === undefined) return dynamicTypes
  if (dynamicTypes === undefined || dynamicTypes.size === 0) return staticTypes
  const merged = new Set(staticTypes)
  for (const type of dynamicTypes) merged.add(type)
  return merged
}
