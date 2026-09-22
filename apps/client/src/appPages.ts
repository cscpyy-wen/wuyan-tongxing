export const CORE_APP_PAGES = Object.freeze([
  'pages/today/index',
  'pages/onboarding/index',
  'pages/records/index',
  'pages/progress/index',
  'pages/profile/index',
  'pages/sos/index',
  'pages/lapse/index',
  'pages/partner/index',
] as const)

/**
 * These pages expose the draft/internal catalog or a high-risk resource and
 * outcome surface listed in docs/content-medical-review.md. They stay out of
 * the first Harmony store package until named review is complete.
 */
export const REVIEW_GATED_APP_PAGES = Object.freeze([
  'pages/lesson/index',
  'pages/medicine/index',
  'pages/faq/index',
  'pages/referral/index',
  'pages/followup/index',
] as const)

export function appPagesForBuildTarget(buildTarget: string | undefined): string[] {
  return buildTarget === 'harmony_cpp'
    ? [...CORE_APP_PAGES]
    : [...CORE_APP_PAGES, ...REVIEW_GATED_APP_PAGES]
}
