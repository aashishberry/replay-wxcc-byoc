/* eslint-disable @next/next/no-img-element -- remote message images are not trusted optimization sources */
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export type MessageAttachment = {
  fileName?: string;
  mimeType?: string;
  fileUrl?: string;
  url?: string;
  sizeBytes?: number;
};

function safeUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function messageUrlTransform(url: string, key: string) {
  if (key === "src") return safeUrl(url) ?? "";
  return defaultUrlTransform(url);
}

function formatBytes(value?: number) {
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageContent({
  text,
  attachments,
}: {
  text: string;
  attachments: MessageAttachment[];
}) {
  return (
    <>
      <div className="rich-message">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeSanitize]}
          urlTransform={messageUrlTransform}
          components={{
            a: ({ children, ...props }) => (
              <a {...props} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
            img: ({ alt, ...props }) => (
              <img
                {...props}
                alt={alt ?? "Message image"}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
      {!!attachments.length && (
        <div className="attachments">
          {attachments.map((attachment, index) => {
            const url = safeUrl(attachment.fileUrl ?? attachment.url);
            if (!url) return null;
            const name = attachment.fileName || `Attachment ${index + 1}`;
            const image = attachment.mimeType
              ?.toLowerCase()
              .startsWith("image/");
            return image ? (
              <a
                className="attachment-image"
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                key={`${url}-${index}`}
              >
                <img
                  src={url}
                  alt={name}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
                <span>{name}</span>
              </a>
            ) : (
              <a
                className="attachment-file"
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                key={`${url}-${index}`}
              >
                <span className="file-icon">↗</span>
                <span>
                  <strong>{name}</strong>
                  <small>
                    {attachment.mimeType || "File"}
                    {attachment.sizeBytes
                      ? ` · ${formatBytes(attachment.sizeBytes)}`
                      : ""}
                  </small>
                </span>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
}
