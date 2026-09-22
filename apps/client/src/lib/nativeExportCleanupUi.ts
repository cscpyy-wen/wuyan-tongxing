import type { NativeExportCleanupIssue } from './runtime'

/** Keep recovery-dialog code off the ordinary startup path; all callers still
 * share the implementation module's single queue and receive loading failures. */
export async function showNativeExportCleanupIssue(issue: NativeExportCleanupIssue, filename?: string): Promise<boolean> {
  const implementation = await import('./nativeExportCleanupUiImpl')
  return implementation.showNativeExportCleanupIssue(issue, filename)
}
