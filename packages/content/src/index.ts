import rawClaims from "./data/claim-matrix.json";
import rawItems from "./data/content-items.json";
import rawEvidence from "./data/evidence-sources.json";

import type {
  ClaimRecord,
  ContentBundle,
  ContentItem,
  ContentKind,
  EvidenceSource,
} from "./types";

export type {
  ClaimRecord,
  ContentBundle,
  ContentChannel,
  ContentItem,
  ContentKind,
  ContentStatus,
  EvidenceSource,
} from "./types";

export const CONTENT_VERSION = "0.1.1" as const;

export const CONTENT_ITEMS = rawItems as ContentItem[];
export const EVIDENCE_CATALOG = rawEvidence as EvidenceSource[];
export const CLAIM_MATRIX = rawClaims as ClaimRecord[];

export const evidenceSources = EVIDENCE_CATALOG;

export const contentById: Readonly<Record<string, ContentItem>> = Object.freeze(
  Object.fromEntries(CONTENT_ITEMS.map((item) => [item.id, item])),
);

export const evidenceById: Readonly<Record<string, EvidenceSource>> = Object.freeze(
  Object.fromEntries(EVIDENCE_CATALOG.map((source) => [source.id, source])),
);

export const contentItemsByKind: Readonly<Record<ContentKind, readonly ContentItem[]>> =
  Object.freeze(
    CONTENT_ITEMS.reduce<Record<ContentKind, ContentItem[]>>(
      (groups, item) => {
        groups[item.kind].push(item);
        return groups;
      },
      {
        preparation: [],
        daily: [],
        maintenance: [],
        followup: [],
        sos: [],
        lapse_recovery: [],
        medication_referral: [],
        faq: [],
        partner_share: [],
      },
    ),
  );

export const contentBundle: ContentBundle = Object.freeze({
  schemaVersion: "1.0",
  contentVersion: CONTENT_VERSION,
  status: "draft",
  channel: "internal",
  reviewNotice: "循证草案，待具名医学审核；仅限内部测试。",
  medicalBoundary:
    "本内容用于戒烟行为支持和一般健康教育，不诊断、不处方、不替代医生、药师或戒烟门诊的个体化建议。",
  itemCount: CONTENT_ITEMS.length,
  items: CONTENT_ITEMS,
});

export function getContentItem(id: string): ContentItem | undefined {
  return contentById[id];
}

export function getContentBootstrap(): {
  bundle: ContentBundle;
  evidence: readonly EvidenceSource[];
} {
  return { bundle: contentBundle, evidence: evidenceSources };
}
