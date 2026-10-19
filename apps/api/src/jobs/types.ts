import { z } from "zod";

export const ProviderId = z.enum(["imanage", "netdocuments", "onedrive", "dropbox", "google_drive", "sharepoint", "box"]);
export const RemoteFileInput = z.object({
  id: z.string().min(1).max(2048), name: z.string().min(1).max(1024), mimeType: z.string().max(256),
  folder: z.boolean().default(false), parentId: z.string().optional(), driveId: z.string().optional(),
});
export type RemoteFile=z.infer<typeof RemoteFileInput>;
export const JobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("export"), documentId: z.string(), fromVersion: z.number().int().positive(), toVersion: z.number().int().positive(), fromHash: z.string(), toHash: z.string(), outputPath: z.string() }),
  z.object({ kind: z.literal("provider_import"), provider: ProviderId, file: RemoteFileInput }),
  z.object({ kind: z.literal("content_backfill") }),
  z.object({ kind: z.literal("integrity_sweep") }),
  z.object({ kind: z.literal("orphan_cleanup") }),
]);
export type JobPayload = z.infer<typeof JobPayloadSchema>;
export const JobOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provider_import"), imported: z.boolean(), document: z.object({ id: z.string(), title: z.string(), version: z.number() }) }),
  z.object({ kind: z.literal("maintenance"), checked: z.number(), changed: z.number() }),
]);
export type JobOutput = z.infer<typeof JobOutputSchema>;

export interface ContentSnapshot {
  documentId: string;
  version: number;
  contentHash: string;
  createdAt: string;
  summary: string;
  contentPath?: string;
  byteLength: number;
  utf16Length: number;
  wordCount: number;
  hasInline: boolean;
}
export interface SnapshotCursor { documentId: string; version: number }
export interface SnapshotObject extends SnapshotCursor {
  contentHash: string; contentPath: string; byteLength: number; utf16Length: number; wordCount: number;
}
export class JobCancelledError extends Error {}
