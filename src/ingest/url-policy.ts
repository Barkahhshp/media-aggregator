import ipaddr from "ipaddr.js";

function normalizedHost(host: string): string {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unwrapped.toLowerCase().replace(/\.$/, "");
}

function rawHostname(input: string): string | null {
  const authority = input.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (authority === undefined || authority.includes("@")) return null;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) {
    const closingBracket = hostPort.indexOf("]");
    return closingBracket < 0 ? null : hostPort.slice(1, closingBracket).toLowerCase();
  }
  return hostPort.split(":", 1)[0]?.toLowerCase() ?? null;
}

function isUnsafeSpecialUseHost(host: string): boolean {
  const hostname = normalizedHost(host);
  const specialUseSuffixes = ["localhost", "local", "internal", "test", "invalid", "example", "arpa", "onion", "lan", "home", "corp", "intranet"];
  return specialUseSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function assertPublicHost(hostname: string, originalHostname: string | null): void {
  const host = normalizedHost(hostname);
  if (host.length === 0 || isUnsafeSpecialUseHost(host)) throw new Error("URL host is not public");

  if (ipaddr.isValid(host)) {
    let address: ReturnType<typeof ipaddr.process>;
    try {
      address = ipaddr.process(host);
    } catch {
      throw new Error("URL host is not a valid public address");
    }
    if (address.range() !== "unicast") throw new Error("URL host is not public");

    if (address.kind() === "ipv4" && originalHostname !== null) {
      const canonicalMappedIpv6 = originalHostname.includes(":") && ipaddr.IPv6.isValid(originalHostname);
      if (!canonicalMappedIpv6 && address.toString() !== originalHostname) {
        throw new Error("Non-canonical numeric URL hosts are not allowed");
      }
    }
    return;
  }
  if (!host.includes(".")) throw new Error("Single-label hosts are not public");
}

export function normalizeAndValidateUrl(input: string, expectedHost?: string): URL {
  const originalHostname = rawHostname(input);
  if (originalHostname === null) throw new Error("URL must use a canonical absolute HTTP authority");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("URL must be absolute and valid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs are allowed");
  if (url.username.length > 0 || url.password.length > 0) throw new Error("URL credentials are not allowed");
  if (url.port !== "" && url.port !== "80" && url.port !== "443") throw new Error("Only ports 80 and 443 are allowed");

  assertPublicHost(url.hostname, originalHostname);

  const actualHost = normalizedHost(url.hostname);
  if (expectedHost !== undefined && actualHost !== normalizedHost(expectedHost)) {
    throw new Error("URL host does not match the expected source host");
  }

  url.hash = "";
  return url;
}
