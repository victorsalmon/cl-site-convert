import { describe, expect, it } from "vitest";

import {
  auditCanonicals,
  auditIndexHtml,
  auditTrailingSlash,
  buildUrlContract,
  resolveCanonical,
} from "../src/source/seo/url-contract.js";

const BASE = "https://upscalehavens.ca";

describe("resolveCanonical", () => {
  it("reduces an absolute canonical to the path it names", () => {
    expect(resolveCanonical("https://upscalehavens.ca/care/", BASE)).toEqual({
      resolved: "/care/",
      offOrigin: false,
      insecure: false,
      relative: false,
    });
  });

  it("keeps the query string, because a query is part of the identity", () => {
    expect(resolveCanonical("https://upscalehavens.ca/?fluent-form=3", BASE).resolved).toBe(
      "/?fluent-form=3",
    );
  });

  it("marks a relative canonical as relative", () => {
    expect(resolveCanonical("/care/", BASE)).toMatchObject({ resolved: "/care/", relative: true });
  });

  it("flags another origin", () => {
    expect(resolveCanonical("https://example.test/care/", BASE).offOrigin).toBe(true);
  });

  it("flags http on an https site", () => {
    expect(resolveCanonical("http://upscalehavens.ca/care/", BASE).insecure).toBe(true);
  });
});

describe("auditCanonicals — every page's canonical must equal its route", () => {
  it("matches the real capture's absolute form against its routes", () => {
    const audit = auditCanonicals(BASE, [
      { url: "/", canonical: "https://upscalehavens.ca/" },
      { url: "/care/", canonical: "https://upscalehavens.ca/care/" },
      { url: "/mlm/onboard-mlm/", canonical: "https://upscalehavens.ca/mlm/onboard-mlm/" },
    ]);
    expect(audit.mismatches).toEqual([]);
    expect(audit.matches).toBe(3);
    expect(audit.checks.every((check) => check.reason === null)).toBe(true);
  });

  it("treats a trailing-slash difference as a mismatch, because it is a second URL", () => {
    const audit = auditCanonicals(BASE, [
      { url: "/care/", canonical: "https://upscalehavens.ca/care" },
    ]);
    expect(audit.mismatches).toHaveLength(1);
    expect(audit.mismatches[0]?.reason).toBe("path-mismatch");
  });

  it("distinguishes a query mismatch from a path mismatch", () => {
    const audit = auditCanonicals(BASE, [
      { url: "/care/?page=2", canonical: "https://upscalehavens.ca/care/" },
    ]);
    expect(audit.mismatches[0]?.reason).toBe("query-mismatch");
  });

  it("reports an absent canonical as a finding rather than skipping the page", () => {
    const audit = auditCanonicals(BASE, [{ url: "/care/", canonical: null }]);
    expect(audit.mismatches[0]).toMatchObject({
      route: "/care/",
      declared: null,
      reason: "absent",
    });
  });

  it("reports an off-origin canonical", () => {
    const audit = auditCanonicals(BASE, [
      { url: "/care/", canonical: "https://staging.example.test/care/" },
    ]);
    expect(audit.mismatches[0]?.reason).toBe("off-origin");
  });

  it("reports a canonical that downgrades the protocol", () => {
    const audit = auditCanonicals(BASE, [
      { url: "/care/", canonical: "http://upscalehavens.ca/care/" },
    ]);
    expect(audit.mismatches[0]?.reason).toBe("insecure-protocol");
  });

  it("accepts a site-relative canonical that names the route", () => {
    const audit = auditCanonicals(BASE, [{ url: "/care/", canonical: "/care/" }]);
    expect(audit.mismatches).toEqual([]);
    expect(audit.checks[0]?.relative).toBe(true);
  });
});

describe("auditTrailingSlash", () => {
  it("votes 'always' for the real capture (18 of 18 non-root routes end in /)", () => {
    const routes = ["/", "/care/", "/tmh/", "/mlm/onboard-mlm/"];
    const audit = auditTrailingSlash(routes);
    expect(audit).toMatchObject({ policy: "always", withSlash: 3, withoutSlash: 0 });
    expect(audit.outliers).toEqual([]);
  });

  it("votes 'never' when no non-root route ends in /", () => {
    expect(auditTrailingSlash(["/", "/care", "/tmh"]).policy).toBe("never");
  });

  it("names the minority routes when the policy is mixed", () => {
    const audit = auditTrailingSlash(["/", "/care/", "/tmh/", "/apply"]);
    expect(audit.policy).toBe("mixed");
    expect(audit.outliers).toEqual(["/apply"]);
    expect(audit.note).toContain("301 the other");
  });

  it("refuses to invent a policy from the root route alone", () => {
    expect(auditTrailingSlash(["/"]).policy).toBe("root-only");
  });
});

describe("auditIndexHtml", () => {
  it("passes when no route ends in index.html and the probe 404s", () => {
    const audit = auditIndexHtml(["/", "/care/"], {
      path: "/index.html",
      status: 404,
      location: null,
      resolves: false,
    });
    expect(audit.routes).toEqual([]);
    expect(audit.finding).toBeNull();
  });

  it("raises a finding when a captured route ends in index.html", () => {
    const audit = auditIndexHtml(["/", "/care/index.html"], null);
    expect(audit.routes).toEqual(["/care/index.html"]);
    expect(audit.finding).toContain("index.html");
  });

  it("raises a finding when the probe resolves on a static host", () => {
    const audit = auditIndexHtml(["/"], {
      path: "/index.html",
      status: 200,
      location: null,
      resolves: true,
    });
    expect(audit.finding).toContain("would serve it alongside /");
  });
});

describe("buildUrlContract", () => {
  it("composes the three audits and records the probes verbatim", () => {
    const contract = buildUrlContract({
      baseUrl: BASE,
      pages: [
        { url: "/", canonical: "https://upscalehavens.ca/" },
        { url: "/care/", canonical: "https://upscalehavens.ca/care/" },
      ],
      indexProbe: { path: "/index.html", status: 404, location: null, resolves: false },
      aliasProbe: {
        path: "/care",
        status: 301,
        location: "https://upscalehavens.ca/care/",
        resolves: false,
      },
    });
    expect(contract.canonical.mismatches).toEqual([]);
    expect(contract.trailingSlash.policy).toBe("always");
    expect(contract.aliasProbe?.status).toBe(301);
    expect(contract.indexHtml.probe?.status).toBe(404);
  });
});
