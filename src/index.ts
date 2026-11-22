// Cloudflare Worker entry point: wires runtime bindings into app.handle().

import { handle } from "./app";
import { TimeoutError, type Http } from "./garmin";

const HTTP_TIMEOUT_MS = 15_000;

export interface Env {
  // Secrets Store bindings in production; plain strings are accepted for local dev.
  GARMIN_PERSONAL_API_KEY?: SecretsStoreSecret | string;
  MUSE_CONNECTOR_TOKEN?: SecretsStoreSecret | string;
}

async function readSecret(binding: SecretsStoreSecret | string | undefined): Promise<string> {
  if (!binding) return "";
  if (typeof binding === "string") return binding;
  return (await binding.get()) ?? "";
}

const http: Http = async (method, url, headers) => {
  let res: Response;
  try {
    res = await fetch(url, { method, headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new TimeoutError();
    throw err;
  }
  return { status: res.status, retryAfter: res.headers.get("retry-after"), text: await res.text() };
};

export default {
  async fetch(request, env): Promise<Response> {
    const started = Date.now();
    const response = await handle(request, {
      museToken: () => readSecret(env.MUSE_CONNECTOR_TOKEN),
      garminKey: () => readSecret(env.GARMIN_PERSONAL_API_KEY),
      http,
      log: console.log,
    });
    // Never log credentials, headers, or workout payloads.
    console.log(`${request.method} ${new URL(request.url).pathname} -> ${response.status} in ${Date.now() - started}ms`);
    return response;
  },
} satisfies ExportedHandler<Env>;
