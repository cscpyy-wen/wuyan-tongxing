export type ContentStatus = "draft";

export type ContentChannel = "internal";

export type ContentKind =
  | "preparation"
  | "daily"
  | "maintenance"
  | "followup"
  | "sos"
  | "lapse_recovery"
  | "medication_referral"
  | "faq"
  | "partner_share";

export interface ContentItem {
  id: string;
  kind: ContentKind;
  order: number;
  version: string;
  status: ContentStatus;
  channel: ContentChannel;
  title: string;
  goal: string;
  mechanisms: string[];
  body: string;
  steps: string[];
  action: string;
  riskStatement: string;
  evidenceIds: string[];
}

export interface EvidenceSource {
  id: string;
  title: string;
  organization: string;
  year: number;
  evidenceType:
    | "clinical_guideline"
    | "systematic_review"
    | "randomized_trial"
    | "official_resource"
    | "taxonomy_or_framework"
    | "law_or_regulation";
  url: string;
  scope: string;
  limitations: string;
  checkedOn: string;
}

export interface ClaimRecord {
  id: string;
  claim: string;
  evidenceIds: string[];
  contentIds: string[];
  wordingBoundary: string;
  reviewStatus: "evidence_checked_medical_review_pending";
}

export interface ContentBundle {
  schemaVersion: "1.0";
  contentVersion: string;
  status: ContentStatus;
  channel: ContentChannel;
  reviewNotice: string;
  medicalBoundary: string;
  itemCount: number;
  items: readonly ContentItem[];
}
