import { RelayError } from "./errors";
import { SESSION_COOKIE, SESSION_SECONDS } from "./store";

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

export function getCookie(request: Request, name: string): string {
  return parseCookies(request.headers.get("cookie"))[name] ?? "";
}

export function isSecureRequest(request: Request): boolean {
  const origin = request.headers.get("origin") ?? "";
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    origin.startsWith("https://")
  );
}

export function sessionCookie(token: string | null, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict`;
  return token
    ? `${base}; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`
    : `${base}; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** Management endpoints accept only same-origin browser requests. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") || new URL(request.url).host;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    (origin && origin !== `http://${host}` && origin !== `https://${host}`) ||
    (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none")
  ) {
    throw new RelayError("不允许跨站访问管理接口。", 403, "cross_origin_request");
  }
}
