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

function parseIpv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    if (!/^\d{1,3}$/.test(parts[index])) return null;
    const value = Number(parts[index]);
    if (value > 255) return null;
    octets.push(value);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function isReservedIpv4(a: number, b: number, c: number): boolean {
  return a === 0 // 0.0.0.0/8
    || a === 10 // 10.0.0.0/8
    || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 carrier-grade NAT
    || a === 127 // 127.0.0.0/8 loopback
    || (a === 169 && b === 254) // 169.254.0.0/16 link-local
    || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // 192.0.0.0/24 and 192.0.2.0/24
    || (a === 192 && b === 168) // 192.168.0.0/16
    || (a === 198 && (b === 18 || b === 19)) // 198.18.0.0/15 benchmarking
    || (a === 198 && b === 51 && c === 100) // 198.51.100.0/24
    || (a === 203 && b === 0 && c === 113) // 203.0.113.0/24
    || a >= 224; // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
}

function parseHextets(part: string): number[] | null {
  if (part === "") return [];
  const groups = part.split(":");
  const values: number[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[index])) return null;
    values.push(parseInt(groups[index], 16));
  }
  return values;
}

/** Parses an IPv6 address into exactly 8 hextets, or null. Handles `::`, an embedded dotted IPv4 tail and a `%zone` suffix. */
function parseIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.indexOf(".") !== -1) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = parseHextets(halves[0]);
  const rest = halves.length === 2 ? parseHextets(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  const zeros: number[] = [];
  for (let index = 0; index < missing; index += 1) zeros.push(0);
  return head.concat(zeros, rest);
}

function zeroRange(hextets: number[], start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (hextets[index] !== 0) return false;
  }
  return true;
}

function isReservedIpv6(h: number[]): boolean {
  if (zeroRange(h, 0, 6)) return true; // ::, ::1 and the deprecated IPv4-compatible form
  if (zeroRange(h, 0, 5) && h[5] === 0xffff) return isReservedIpv4(h[6] >> 8, h[6] & 0xff, h[7] >> 8); // IPv4-mapped, either notation
  return (h[0] & 0xffc0) === 0xfe80 // fe80::/10 link-local
    || (h[0] & 0xffc0) === 0xfec0 // fec0::/10 site-local
    || (h[0] & 0xfe00) === 0xfc00 // fc00::/7 unique local
    || (h[0] & 0xff00) === 0xff00 // ff00::/8 multicast
    || (h[0] === 0x0064 && h[1] === 0xff9b && zeroRange(h, 2, 6)) // 64:ff9b::/96 NAT64
    || h[0] === 0x2002 // 2002::/16 6to4
    || (h[0] === 0x2001 && (h[1] === 0x0000 || h[1] === 0x0db8)); // 2001::/32 Teredo and 2001:db8::/32 documentation
}

/** True for every private, reserved or special-purpose address, and for any input that is not a valid IP address. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    return octets === null || isReservedIpv4(octets[0], octets[1], octets[2]);
  }
  if (family === 6) {
    const hextets = parseIpv6(address);
    return hextets === null || isReservedIpv6(hextets);
  }
  return true;
}

/**
 * Returns the parsed URL when `raw` is an allowed protocol on an allowlisted hostname that resolves only to public addresses.
 * Throws HIGGSFIELD_BAD_MEDIA for policy failures, and a plain Error (not a ProviderError) when the host cannot be resolved,
 * which callers treat as a transient failure.
 */
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
    throw new Error("Media host could not be resolved.", { cause: error });
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
