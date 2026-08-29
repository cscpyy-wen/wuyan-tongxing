/**
 * Taro renders system-style modals outside React. Startup recovery, quick-log
 * reconciliation and native cleanup can all discover work during the same
 * frame, so every infrastructure modal shares one process-local queue.
 */
let modalTail: Promise<void> = Promise.resolve()

export function runAppModal<T>(show: () => Promise<T>): Promise<T> {
  const result = modalTail.then(show, show)
  modalTail = result.then(() => undefined, () => undefined)
  return result
}
