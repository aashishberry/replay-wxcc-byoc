export type AttachmentInput = {
  fileName: string;
  mimeType: string;
  fileUrl: string;
};

export type AttachmentPolicy = {
  enabled: boolean;
  maxCount: number;
  maxSingleBytes: number;
  maxTotalBytes: number;
  allowedMimeTypes: string[];
};

const DEFAULT_MIME_TYPES = [
  "image/*",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function metadataFromUrl(url: URL) {
  const encodedName = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let fileName = encodedName;
  try {
    fileName = decodeURIComponent(encodedName);
  } catch {
    // Keep the URL-safe name if it contains malformed percent encoding.
  }
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  return { fileName, mimeType: MIME_BY_EXTENSION[extension] ?? "" };
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function attachmentPolicy(): AttachmentPolicy {
  return {
    enabled: process.env.ATTACHMENTS_ENABLED !== "false",
    maxCount: positiveInteger(process.env.MAX_ATTACHMENT_COUNT, 5),
    maxSingleBytes: positiveInteger(
      process.env.MAX_ATTACHMENT_BYTES,
      10 * 1024 * 1024,
    ),
    maxTotalBytes: positiveInteger(
      process.env.MAX_TOTAL_ATTACHMENT_BYTES,
      25 * 1024 * 1024,
    ),
    allowedMimeTypes: (
      process.env.ALLOWED_ATTACHMENT_MIME_TYPES ?? DEFAULT_MIME_TYPES.join(",")
    )
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  };
}

function mimeAllowed(mimeType: string, patterns: string[]) {
  const normalized = mimeType.toLowerCase();
  return patterns.some((pattern) =>
    pattern.endsWith("/*")
      ? normalized.startsWith(pattern.slice(0, -1))
      : normalized === pattern,
  );
}

export function validateAttachments(value: unknown): AttachmentInput[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Attachments must be a list.");

  const policy = attachmentPolicy();
  if (!policy.enabled && value.length) {
    throw new Error("Attachments are disabled for this messaging channel.");
  }
  if (value.length > policy.maxCount) {
    throw new Error(
      `A message can contain at most ${policy.maxCount} attachments.`,
    );
  }

  const attachments = value.map((item, index) => {
    if (!item || typeof item !== "object")
      throw new Error(`Attachment ${index + 1} is invalid.`);
    const candidate = item as Partial<AttachmentInput>;
    const fileUrl =
      typeof candidate.fileUrl === "string" ? candidate.fileUrl.trim() : "";

    let url: URL;
    try {
      url = new URL(fileUrl);
    } catch {
      throw new Error(`Attachment ${index + 1} needs a valid HTTPS URL.`);
    }
    if (url.protocol !== "https:")
      throw new Error(`Attachment ${index + 1} must use an HTTPS URL.`);
    const derived = metadataFromUrl(url);
    const fileName =
      (typeof candidate.fileName === "string"
        ? candidate.fileName.trim()
        : "") || derived.fileName;
    const mimeType =
      (typeof candidate.mimeType === "string"
        ? candidate.mimeType.trim().toLowerCase()
        : "") || derived.mimeType;
    if (!fileName || fileName.length > 255)
      throw new Error(`Attachment ${index + 1} needs a valid file name.`);
    if (!mimeAllowed(mimeType, policy.allowedMimeTypes))
      throw new Error(`${mimeType || "That file type"} is not allowed.`);
    return { fileName, mimeType, fileUrl: url.toString() };
  });
  return attachments;
}

export function webexAttachments(attachments: AttachmentInput[]) {
  return attachments.map(({ fileName, mimeType, fileUrl }) => ({
    fileName,
    mimeType,
    fileUrl,
  }));
}

export function normalizeMessageTimestamp(
  value: unknown,
  fallback = Date.now(),
) {
  let timestamp: number;
  if (
    typeof value === "string" &&
    value.trim() &&
    !/^[-+]?\d+(\.\d+)?$/.test(value.trim())
  ) {
    timestamp = Date.parse(value);
  } else {
    timestamp = Number(value);
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback;
  if (timestamp < 100_000_000_000) timestamp *= 1000; // epoch seconds
  if (timestamp > 100_000_000_000_000) timestamp /= 1000; // epoch microseconds
  return Math.round(timestamp);
}
