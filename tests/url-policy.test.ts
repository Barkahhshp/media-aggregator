import { describe, expect, it } from "vitest";

interface UrlPolicyModule {
  normalizeAndValidateUrl(input: string, expectedHost?: string): URL;
}

const urlPolicyModules = import.meta.glob<UrlPolicyModule>("../src/ingest/url-policy.ts");

async function loadNormalizeAndValidateUrl() {
  const moduleLoader = urlPolicyModules["../src/ingest/url-policy.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  expect(module.normalizeAndValidateUrl).toBeTypeOf("function");
  return module.normalizeAndValidateUrl;
}

describe("URL policy", () => {
  it("normalizes_a_public_URL_and_removes_its_fragment", async () => {
    const normalizeAndValidateUrl = await loadNormalizeAndValidateUrl();
    if (!normalizeAndValidateUrl) return;

    const result = normalizeAndValidateUrl("HTTPS://ExAmPle.COM:443/news/../feed.xml#latest");

    expect(result.href).toBe("https://example.com/feed.xml");
  });

  it("allows_a_public_literal_IP_but_rejects_noncanonical_numeric_IP_encodings", async () => {
    const normalizeAndValidateUrl = await loadNormalizeAndValidateUrl();
    if (!normalizeAndValidateUrl) return;

    expect(normalizeAndValidateUrl("https://8.8.8.8/dns-query").hostname).toBe("8.8.8.8");
    expect(normalizeAndValidateUrl("https://[2606:4700:4700::1111]/").hostname).toBe("[2606:4700:4700::1111]");
    expect(normalizeAndValidateUrl("https://[::ffff:8.8.8.8]/").hostname).toBe("[::ffff:808:808]");
    for (const url of ["http://0x08080808/", "http://134744072/", "http://010.010.010.010/"]) {
      expect(() => normalizeAndValidateUrl(url)).toThrow();
    }
  });

  it("rejects_noncanonical_numeric_IP_authorities_after_URL_normalization", async () => {
    const normalizeAndValidateUrl = await loadNormalizeAndValidateUrl();
    if (!normalizeAndValidateUrl) return;

    expect(() => normalizeAndValidateUrl("http://8.8.8.8./")).toThrow();
    expect(() => normalizeAndValidateUrl("http://0x08080808./")).toThrow();
    expect(() => normalizeAndValidateUrl("  http://0x08080808/")).toThrow();
    expect(() => normalizeAndValidateUrl("http:\\0x08080808\\x")).toThrow();
  });

  it.each([
    "javascript:alert(1)",
    "ftp://example.com/feed.xml",
    "https://user:secret@example.com/feed.xml",
    "https://@example.com/feed.xml",
    "https://example.com:8443/feed.xml",
    "http://localhost/",
    "http://metadata/",
    "http://redis/",
    "http://service.local/",
    "http://examplehidden.onion/",
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.10/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://192.0.2.1/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[2001:db8::1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[64:ff9b::a00:1]/",
  ])("rejects_private_reserved_or_unsafe_URL_%s", async (url) => {
    const normalizeAndValidateUrl = await loadNormalizeAndValidateUrl();
    if (!normalizeAndValidateUrl) return;
    expect(() => normalizeAndValidateUrl(url)).toThrow();
  });

  it("rejects_cross_host_targets_when_an_expected_host_is_given", async () => {
    const normalizeAndValidateUrl = await loadNormalizeAndValidateUrl();
    if (!normalizeAndValidateUrl) return;

    expect(() => normalizeAndValidateUrl("https://evil.example/path", "example.com")).toThrow();
    expect(normalizeAndValidateUrl("https://EXAMPLE.com/path", "example.com").hostname).toBe("example.com");
  });
});
