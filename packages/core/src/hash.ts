import { createHash } from "node:crypto";

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
