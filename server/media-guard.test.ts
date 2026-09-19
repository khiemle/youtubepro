import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import {
  DEFAULT_MEDIA_POLICY,
  assertSafeMediaUrl,
  downloadImage,
  isPrivateAddress,
  sniffImageMime,
  uploadBytes,
  type MediaDeps,
  type MediaUrlPolicy,
} from "./media-guard";
import { ProviderError } from "./provider-errors";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PUBLIC_IP = "93.184.216.34";

/** Lets tests talk to a local http server while keeping every other rule of the real policy. */
const LOCAL_POLICY: MediaUrlPolicy = { protocols: ["http:"], hostSuffixes: ["localhost"], resolve: async () => [PUBLIC_IP] };

const servers: http.Server[] = [];

async function startServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function deps(overrides: Partial<MediaDeps> = {}): MediaDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    fetchImpl: (input, init) => fetch(input, init),
    policy: LOCAL_POLICY,
    sleep: async (ms) => { sleeps.push(ms); },
    maxBytes: 1024,
    ...overrides,
    sleeps,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the promise to reject" });
}

describe("isPrivateAddress", () => {
  test("flags loopback, private, link-local and unusable addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  test("allows public addresses", () => {
    for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });
});

describe("assertSafeMediaUrl with the default policy", () => {
  const resolvesPublic: MediaUrlPolicy = { ...DEFAULT_MEDIA_POLICY, resolve: async () => [PUBLIC_IP] };

  test("accepts an https URL on an allowlisted host", async () => {
    const url = await assertSafeMediaUrl("https://cdn.higgsfield.ai/a/b.png?sig=1", resolvesPublic);
    assert.equal(url.hostname, "cdn.higgsfield.ai");
  });

  test("accepts the two exact hosts recorded by live check #2 and nothing wider", async () => {
    for (const good of [
      "https://d8j0ntlcm91z4.cloudfront.net/x.png?sig=1",
      "https://fast-and-furious-input-prod-20250325165756276100000002.s3.amazonaws.com/uploads/a.png?X-Amz-Signature=1",
    ]) {
      const url = await assertSafeMediaUrl(good, resolvesPublic);
      assert.equal(url.protocol, "https:", good);
    }
    for (const bad of [
      "https://other-bucket.s3.amazonaws.com/x",
      "https://other.cloudfront.net/x",
      "https://evil-d8j0ntlcm91z4.cloudfront.net/x",
      "https://d8j0ntlcm91z4.cloudfront.net.evil.example/x",
    ]) {
      const error = await rejection(assertSafeMediaUrl(bad, resolvesPublic));
      assert.equal(error.code, "HIGGSFIELD_BAD_MEDIA", bad);
    }
  });

  test("rejects other protocols, hosts, credentials and IP literals", async () => {
    for (const bad of [
      "http://cdn.higgsfield.ai/a.png",
      "https://evil.example/a.png",
      "https://higgsfield.ai.evil.example/a.png",
      "https://user:pw@cdn.higgsfield.ai/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "not a url",
    ]) {
      const error = await rejection(assertSafeMediaUrl(bad, resolvesPublic));
      assert.equal(error.code, "HIGGSFIELD_BAD_MEDIA", bad);
    }
  });

  test("rejects an allowlisted host that resolves to a private address", async () => {
    const error = await rejection(assertSafeMediaUrl("https://cdn.higgsfield.ai/a.png", { ...DEFAULT_MEDIA_POLICY, resolve: async () => ["10.0.0.5"] }));
    assert.equal(error.code, "HIGGSFIELD_BAD_MEDIA");
  });
});

describe("sniffImageMime", () => {
  test("recognises PNG, JPEG and WebP by their bytes", () => {
    assert.equal(sniffImageMime(PNG), "image/png");
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(sniffImageMime(Buffer.from("<html>")), null);
  });
});

describe("downloadImage", () => {
  test("returns the bytes and sniffed type", async () => {
    const base = await startServer((_req, res) => { res.setHeader("content-type", "application/octet-stream"); res.end(PNG); });
    const result = await downloadImage(`${base}/a.png`, deps());
    assert.deepEqual(result, { bytes: PNG, mimeType: "image/png" });
  });

  test("retries a 5xx twice with backoff, then succeeds", async () => {
    let calls = 0;
    const base = await startServer((_req, res) => {
      calls += 1;
      if (calls < 3) { res.statusCode = 500; res.end("no"); } else { res.end(PNG); }
    });
    const testDeps = deps();
    const result = await downloadImage(`${base}/flaky.png`, testDeps);
    assert.equal(result.mimeType, "image/png");
    assert.equal(calls, 3);
    assert.deepEqual(testDeps.sleeps, [500, 1_500]);
  });

  test("gives up after three failed attempts with HIGGSFIELD_DOWNLOAD_FAILED", async () => {
    const base = await startServer((_req, res) => { res.statusCode = 503; res.end(); });
    const error = await rejection(downloadImage(`${base}/x.png`, deps()));
    assert.equal(error.code, "HIGGSFIELD_DOWNLOAD_FAILED");
    assert.equal(error.retryable, true);
  });

  test("does not retry a 4xx", async () => {
    let calls = 0;
    const base = await startServer((_req, res) => { calls += 1; res.statusCode = 404; res.end(); });
    const error = await rejection(downloadImage(`${base}/gone.png`, deps()));
    assert.equal(error.code, "HIGGSFIELD_DOWNLOAD_FAILED");
    assert.equal(calls, 1);
  });

  test("rejects non-image bytes and oversize bodies without retrying", async () => {
    const html = await startServer((_req, res) => { res.end("<html>hello</html>"); });
    assert.equal((await rejection(downloadImage(`${html}/a`, deps()))).code, "HIGGSFIELD_BAD_MEDIA");

    const big = await startServer((_req, res) => { res.end(Buffer.concat([PNG, Buffer.alloc(2_000)])); });
    assert.equal((await rejection(downloadImage(`${big}/a`, deps({ maxBytes: 100 })))).code, "HIGGSFIELD_BAD_MEDIA");
  });

  test("follows a redirect that stays on an allowed host and refuses one that leaves it", async () => {
    const base = await startServer((req, res) => {
      if (req.url === "/start") { res.statusCode = 302; res.setHeader("location", "/final.png"); res.end(); }
      else if (req.url === "/leave") { res.statusCode = 302; res.setHeader("location", "http://evil.example/steal"); res.end(); }
      else { res.end(PNG); }
    });
    assert.equal((await downloadImage(`${base}/start`, deps())).mimeType, "image/png");
    assert.equal((await rejection(downloadImage(`${base}/leave`, deps()))).code, "HIGGSFIELD_BAD_MEDIA");
  });

  test("applies the URL policy before any request is made", async () => {
    let requested = false;
    const base = await startServer((_req, res) => { requested = true; res.end(PNG); });
    const strict: MediaUrlPolicy = { ...LOCAL_POLICY, hostSuffixes: ["not-localhost.test"] };
    assert.equal((await rejection(downloadImage(`${base}/a.png`, deps({ policy: strict })))).code, "HIGGSFIELD_BAD_MEDIA");
    assert.equal(requested, false);
  });
});

describe("uploadBytes", () => {
  test("PUTs the exact bytes with the content type", async () => {
    let received: { method?: string; type?: string; body: Buffer } | undefined;
    const base = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => { received = { method: req.method, type: req.headers["content-type"], body: Buffer.concat(chunks) }; res.end(); });
    });
    await uploadBytes(`${base}/upload/1`, PNG, "image/png", deps());
    assert.equal(received?.method, "PUT");
    assert.equal(received?.type, "image/png");
    assert.deepEqual(received?.body, PNG);
  });

  test("reports a failed upload as HIGGSFIELD_UPLOAD_FAILED", async () => {
    const base = await startServer((_req, res) => { res.statusCode = 403; res.end(); });
    const error = await rejection(uploadBytes(`${base}/upload/1`, PNG, "image/png", deps()));
    assert.equal(error.code, "HIGGSFIELD_UPLOAD_FAILED");
    assert.equal(error.retryable, true);
  });

  test("refuses an upload URL outside the policy", async () => {
    const error = await rejection(uploadBytes("https://evil.example/put", PNG, "image/png", deps({ policy: DEFAULT_MEDIA_POLICY })));
    assert.equal(error.code, "HIGGSFIELD_BAD_MEDIA");
  });
});
