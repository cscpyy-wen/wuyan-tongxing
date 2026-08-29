export function isSourceSnapshotExcluded(pathname) {
  const normalized = String(pathname).replaceAll('\\', '/')
  return normalized.startsWith('release/android/')
    || normalized.startsWith('release/.android-publication-')
    || normalized.startsWith('release/.android-previous-')
    || /(?:^|\/)\.kotlin\/sessions\/[^/]+\.salive$/i.test(normalized)
}
