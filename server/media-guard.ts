import { lookup } from "node:dns/promises";
import net from "node:net";
import { ProviderError } from "./provider-errors";

/**
 * Hosts Higgsfield media (result images and upload URLs) may live on. The two non-higgsfield.ai entries are
 * exact hosts recorded by live check #2 on 2026-09-19. NEVER widen them to `.amazonaws.com` or
 * `.cloudfront.net`: a broad entry would let a manipulated model reply direct the operator's reference
 * images to an attacker's bucket. If Higgsfield rotates the input bucket (its name carries a date), uploads
 * fail with HIGGSFIELD_BAD_MEDIA naming the new host, and this constant is updated.
 */
export const HIGGSFIELD_MEDIA_HOST_SUFFIXES = [
  ".higgsfield.ai",
  ".d8j0ntlcm91z4.cloudfront.net",
  ".fast-and-furious-input-prod-20250325165756276100000002.s3.amazonaws.com",
] as const;

const MAX_REDIRECTS = 2;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = [500, 1_500] as const;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface MediaUrlPolicy {
  protocols: readonly string[];
  /** Entries match the host itself and any subdomain; a leading dot is optional. */
  hostSuffixes: readonly string[];
  resolve: (hostname: string) => Promise<string[]>;
}

export interface MediaDeps {
  fetchImpl: typeof fetch;
  policy: MediaUrlPolicy;
  sleep: (ms: number) => Promise<void>;
  maxBytes: number;
}

export const DEFAULT_MEDIA_POLICY: MediaUrlPolicy = {
  protocols: ["https:"],
  hostSuffixes: HIGGSFIELD_MEDIA_HOST_SUFFIXES,
  resolve: async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address),
};

export const defaultMediaDeps: MediaDeps = {
  fetchImpl: (input, init) => fetch(input, init),
  policy: DEFAULT_MEDIA_POLICY,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxBytes: 25 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function badMedia(message: string, cause?: unknown): ProviderError {
  return new ProviderError({
    message,
    code: "HIGGSFIELD_BAD_MEDIA",
    category: "invalid_response",
    status: 502,
    retryable: false,
    publicMessage: "Higgsfield returned media the server refused to use.",
    suggestion: "Retry once. If it continues, report the HIGGSFIELD_BAD_MEDIA code from the server log.",
    cause,
  });
}

export function downloadFailed(cause?: unknown): ProviderError {
  return new ProviderError({
    message: "Downloading the generated image failed.",
    code: "HIGGSFIELD_DOWNLOAD_FAILED",
    category: "network",
    status: 502,
    retryable: true,
    publicMessage: "The generated image could not be downloaded.",
    suggestion: "Check the server network connection and retry.",
    cause,
  });
}

export function uploadFailed(cause?: unknown): ProviderError {
  return new ProviderError({
    message: "Uploading a reference image failed.",
    code: "HIGGSFIELD_UPLOAD_FAILED",
    category: "network",
    status: 502,
    retryable: true,
    publicMessage: "A reference image could not be uploaded to Higgsfield.",
    suggestion: "Check the server network connection and retry. Nothing was generated or charged.",
    cause,
  });
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true;
}

/** Throws HIGGSFIELD_BAD_MEDIA unless `raw` is an allowed protocol on an allowlisted hostname that resolves only to public addresses. */
export async function assertSafeMediaUrl(raw: string, policy: MediaUrlPolicy = DEFAULT_MEDIA_POLICY): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw badMedia("Media URL is not a valid URL.", error);
  }
  if (!policy.protocols.includes(url.protocol)) throw badMedia(`Media URL protocol ${url.protocol} is not allowed.`);
  if (url.username || url.password) throw badMedia("Media URL must not carry credentials.");

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host) !== 0) throw badMedia("Media URL must use a hostname, not an IP address.");
  const allowed = policy.hostSuffixes.some((suffix) => {
    const bare = suffix.replace(/^\./, "").toLowerCase();
    return host === bare || host.endsWith(`.${bare}`);
  });
  if (!allowed) throw badMedia(`Media host ${host} is not on the allowlist.`);

  let addresses: string[];
  try {
    addresses = await policy.resolve(host);
  } catch (error) {
    throw badMedia("Media host could not be resolved.", error);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw badMedia("Media host resolves to a private or unusable address.");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function guardedFetch(rawUrl: string, init: RequestInit, deps: MediaDeps): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertSafeMediaUrl(current, deps.policy);
    const response = await deps.fetchImpl(url, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  throw badMedia("Media URL redirected too many times.");
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw badMedia("Media is larger than the allowed size.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw badMedia("Media is larger than the allowed size.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = (start: number, length: number) => String.fromCharCode(...Array.from(bytes.subarray(start, start + length)));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

/** GETs an image through the URL policy. Retries network failures and 5xx twice; policy, size and type failures fail immediately. */
export async function downloadImage(
  rawUrl: string,
  deps: MediaDeps = defaultMediaDeps,
): Promise<{ bytes: Buffer; mimeType: ImageMime }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await guardedFetch(rawUrl, { method: "GET" }, deps);
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw downloadFailed(new Error(`HTTP ${response.status}`));
      const bytes = await readCapped(response, deps.maxBytes);
      const mimeType = sniffImageMime(bytes);
      if (!mimeType) throw badMedia("Downloaded media is not a PNG, JPEG, or WebP image.");
      return { bytes, mimeType };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) await deps.sleep(DOWNLOAD_BACKOFF_MS[attempt - 1]);
    }
  }
  throw downloadFailed(lastError);
}

/** PUTs bytes to a presigned upload URL through the URL policy. Not retried: nothing has been submitted or charged yet. */
export async function uploadBytes(
  rawUrl: string,
  bytes: Buffer,
  contentType: string,
  deps: MediaDeps = defaultMediaDeps,
): Promise<void> {
  let response: Response;
  try {
    response = await guardedFetch(rawUrl, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(bytes) }, deps);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw uploadFailed(error);
  }
  if (!response.ok) throw uploadFailed(new Error(`HTTP ${response.status}`));
}
