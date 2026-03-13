import chalk from "chalk";
import { chromium, type Request as PlaywrightRequest } from "playwright";
import { logger } from "../logger/index.js";
import { RedirectPolicy, type Context, type Response } from "./types.js";
import {
  extractJsVariables,
  getHostFromUrl,
  isFirstPartyHost,
  sleep,
} from "./utils.js";

function colorizeStatusCode(statusCode: number): string {
  const code = String(statusCode);

  if (statusCode >= 100 && statusCode < 200) {
    return chalk.cyan(code);
  }
  if (statusCode >= 200 && statusCode < 300) {
    return chalk.green(code);
  }
  if (statusCode >= 300 && statusCode < 400) {
    return chalk.blue(code);
  }
  if (statusCode >= 400 && statusCode < 500) {
    return chalk.yellow(code);
  }
  if (statusCode >= 500 && statusCode < 600) {
    return chalk.red(code);
  }

  return chalk.gray(code);
}

export async function openPage(
  url: string,
  timeoutMs: number,
  javascriptVariableNames: string[],
  userAgent?: string,
  redirectPolicy: RedirectPolicy = RedirectPolicy.Any,
): Promise<Context> {
  const pageHost = getHostFromUrl(url);
  if (!pageHost) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(userAgent ? { userAgent } : {}),
  });
  const page = await context.newPage();

  const responses: Response[] = [];
  let navigationGeneration = 0;
  const requestGenerations = new WeakMap<PlaywrightRequest, number>();
  let navigationBlockedByPolicy = false;
  const responsesByGeneration = new Map<number, Response[]>();
  const hostByGeneration = new Map<number, string>();
  hostByGeneration.set(0, pageHost);

  function getResponsesForGeneration(generation: number): Response[] {
    const existing = responsesByGeneration.get(generation);
    if (existing) {
      return existing;
    }
    const created: Response[] = [];
    responsesByGeneration.set(generation, created);
    return created;
  }

  if (redirectPolicy !== RedirectPolicy.Any) {
    let isFirstRequest = true;

    await page.route("**/*", (route) => {
      const request = route.request();

      // Only policy-check top-level navigation requests.
      if (
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      ) {
        return route.continue();
      }

      // Allow the very first navigation request (the user's goto URL)
      if (isFirstRequest) {
        isFirstRequest = false;
        return route.continue();
      }

      // Check if target host is within policy scope
      const targetHost = getHostFromUrl(request.url());
      if (!targetHost) {
        return route.continue();
      }

      const allowed =
        redirectPolicy === RedirectPolicy.SameHost
          ? targetHost === pageHost
          : isFirstPartyHost(pageHost, targetHost);

      if (allowed) {
        return route.continue();
      }

      // Block out-of-scope navigation
      logger.warn(
        `Navigation to ${chalk.cyan(targetHost)} blocked by redirect policy '${redirectPolicy}'`,
      );
      navigationBlockedByPolicy = true;
      return route.abort();
    });
  }

  page.on("request", (request) => {
    requestGenerations.set(request, navigationGeneration);
  });

  page.on("response", async (response) => {
    const gen = requestGenerations.get(response.request()) ?? -1;
    const responseUrl = response.url();
    const responseHost = getHostFromUrl(responseUrl) ?? "";
    const statusCode = response.status();
    logger.debug(
      `Received response [${colorizeStatusCode(statusCode)}] ${responseUrl}`,
    );
    const res: Response = {
      url: responseUrl,
      host: responseHost,
      isFirstParty: false,
      status: statusCode,
      headers: response.headers(),
    };

    const body = await response.text().catch(() => null);
    if (body) {
      res.body = body;
    }

    if (gen < 0) return;
    getResponsesForGeneration(gen).push(res);
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      const frameHost = getHostFromUrl(frame.url());
      if (!frameHost) {
        // Ignore pseudo navigations like browser error pages.
        return;
      }
      navigationGeneration++;
      hostByGeneration.set(navigationGeneration, frameHost);
    }
  });

  let timeoutOccurred = false;
  const goto = page.goto(url, { waitUntil: "networkidle" });

  const result = await Promise.race([
    goto.then(() => "loaded").catch((e) => e.message),
    sleep(timeoutMs).then(() => "timeout"),
  ]);

  if (result === "loaded") {
    logger.info("Page loaded successfully");
  } else if (result === "timeout") {
    timeoutOccurred = true;
    logger.warn(`Timeout of ${timeoutMs}ms exceeded while loading ${url}`);
  } else if (navigationBlockedByPolicy) {
    logger.info("Page loaded (redirect blocked by policy)");
  } else {
    logger.error(`Error loading page ${url}: ${result.split("\n")[0]}`);
  }

  let selectedGeneration = navigationGeneration;
  if (redirectPolicy !== RedirectPolicy.Any) {
    const isInScopeHost = (host: string): boolean =>
      redirectPolicy === RedirectPolicy.SameHost
        ? host === pageHost
        : isFirstPartyHost(pageHost, host);

    for (let gen = navigationGeneration; gen >= 0; gen--) {
      const host = hostByGeneration.get(gen);
      if (host && isInScopeHost(host)) {
        selectedGeneration = gen;
        break;
      }
    }
    logger.debug(`Using in-scope generation ${selectedGeneration}`);
  }

  // Use the final URL (after redirects) to determine first-party scope.
  const finalHost = getHostFromUrl(page.url()) ?? pageHost;
  const scopeHost = hostByGeneration.get(selectedGeneration) ?? finalHost;

  if (finalHost !== pageHost) {
    logger.debug(
      `Redirect detected: final host ${chalk.cyan(finalHost)} (original: ${chalk.cyan(pageHost)})`,
    );
  }

  // Remove redirect responses (they have no content, only intermediate infrastructure headers)
  const selectedResponses = responsesByGeneration.get(selectedGeneration) ?? [];
  const filtered = selectedResponses.filter(
    (r) => r.status < 300 || r.status >= 400,
  );
  responses.push(...filtered);

  // Recalculate isFirstParty for all responses based on the scope host
  for (const res of responses) {
    res.isFirstParty = res.host
      ? isFirstPartyHost(scopeHost, res.host)
      : false;
  }

  let cookies: Context["cookies"] = [];
  let javascriptVariables: Record<string, unknown> = {};

  try {
    cookies = (await page.context().cookies()).map((cookie) => {
      const cookieHost = cookie.domain.replace(/^\./, "").toLowerCase();
      return {
        host: cookieHost,
        isFirstParty: isFirstPartyHost(scopeHost, cookieHost),
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      };
    });

    javascriptVariables = await page.evaluate(
      ({ varNames, extractFn }) => {
        // Re-create the function in browser context
        const fn = new Function("return " + extractFn)();
        return fn(window, varNames);
      },
      {
        varNames: javascriptVariableNames,
        extractFn: extractJsVariables.toString(),
      },
    );
  } catch {
    logger.warn(
      "Failed to extract cookies or JavaScript variables (page context may have been destroyed)",
    );
  }

  return {
    browser,
    page,
    responses,
    javascriptVariables,
    cookies,
    timeoutMs,
    timeoutOccurred,
  };
}
