import { z } from "zod";

export const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() })
});

export const AdminReleaseSchema = z.object({
  note: z.string().trim().min(3).max(500),
  rules: z.array(z.unknown()).max(500),
  evidenceReviewed: z.literal(true),
  acknowledgeDraftBanner: z.literal(true)
});

export const telemetryPropertyAllowlist = new Set([
  "page", "source", "result", "durationBucket", "dayBucket", "path", "version"
]);
