import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  analyseChain,
  buildRedirectMap,
  isExternal,
  locationMatches,
  sitePathOf,
  toCloudflareRedirects,
} from "../src/source/seo/redirects.js";
import type { RedirectArrival, RedirectEntry } from "../src/source/seo/redirects.js";

interface Scenario {
  entries: RedirectEntry[];
  arrivals: ({ from: string } & RedirectArrival)[];
  finalStatuses: { from: string; status: number | null }[];
}

interface ScenarioFile {
  baseUrl: string;
  scenarios: Record<string, Scenario>;
}

const FIXTURES = join(import.meta.dirname, "fixtures", "seo");
const scenarioFile = JSON.parse(
  readFileSync(join(FIXTURES, "redirects.scenarios.json"), "utf8"),
) as ScenarioFile;

const scenario = (name: string): Scenario => {
  const found = scenarioFile.scenarios[name];
  if (found === undefined) throw new Error(`no scenario ${name}`);
  return found;
};

function build(name: string): ReturnType<typeof buildRedirectMap> {
  const value = scenario(name);
  const arrivals = new Map<string, RedirectArrival>(
    value.arrivals.map((arrival) => [
      arrival.from,
      { status: arrival.status, location: arrival.location },
    ]),
  );
  const finalStatuses = new Map<string, number | null>(
    value.finalStatuses.map((entry) => [entry.from, entry.status]),
  );
  return buildRedirectMap({
    baseUrl: scenarioFile.baseUrl,
    entries: value.entries,
    arrivals,
    finalStatuses,
  });
}

describe("isExternal / sitePathOf", () => {
  it("treats an off-origin absolute URL as external", () => {
    expect(isExternal("https://drive.google.com/file/d/abc/view", scenarioFile.baseUrl)).toBe(true);
  });

  it("treats a same-origin absolute URL as internal and reduces it to a path", () => {
    expect(sitePathOf("https://example.test/?fluent-form=3", scenarioFile.baseUrl)).toBe(
      "/?fluent-form=3",
    );
  });

  it("treats a bare path as internal", () => {
    expect(isExternal("/care/", scenarioFile.baseUrl)).toBe(false);
    expect(sitePathOf("/care/", scenarioFile.baseUrl)).toBe("/care/");
  });
});

describe("analyseChain", () => {
  const healthy = new Map(scenario("healthy").entries.map((entry) => [entry.from, entry]));
  const chained = new Map(scenario("chain").entries.map((entry) => [entry.from, entry]));
  const looped = new Map(scenario("loop").entries.map((entry) => [entry.from, entry]));

  it("counts a direct redirect as one hop with no chain", () => {
    const entry = healthy.get("/apply");
    expect(entry).toBeDefined();
    const analysis = analyseChain(entry as RedirectEntry, healthy, scenarioFile.baseUrl);
    expect(analysis).toMatchObject({ hops: 1, loop: false, terminal: "/?fluent-form=3" });
    expect(analysis.chain).toEqual(["/apply", "/?fluent-form=3"]);
  });

  it("keeps an external destination in the chain and terminates it", () => {
    const entry = healthy.get("/bylaws") as RedirectEntry;
    const analysis = analyseChain(entry, healthy, scenarioFile.baseUrl);
    expect(analysis).toMatchObject({ hops: 1, loop: false, terminal: null });
    expect(analysis.chain.at(-1)).toBe("https://drive.example.com/file/abc/view");
  });

  it("follows an internal edge into another redirect and counts both hops", () => {
    const entry = chained.get("/a") as RedirectEntry;
    const analysis = analyseChain(entry, chained, scenarioFile.baseUrl);
    expect(analysis).toMatchObject({ hops: 2, loop: false, terminal: "/c" });
    expect(analysis.chain).toEqual(["/a", "/b", "/c"]);
  });

  it("detects a loop instead of following it forever", () => {
    const entry = looped.get("/x") as RedirectEntry;
    const analysis = analyseChain(entry, looped, scenarioFile.baseUrl);
    expect(analysis.loop).toBe(true);
    expect(analysis.chain).toEqual(["/x", "/y", "/x"]);
  });

  it("stops at maxHops for a map too long to be a map", () => {
    const long = new Map<string, RedirectEntry>();
    for (let i = 0; i < 20; i += 1) {
      long.set(`/p${String(i)}`, { from: `/p${String(i)}`, to: `/p${String(i + 1)}`, code: 301 });
    }
    const analysis = analyseChain(long.get("/p0") as RedirectEntry, long, scenarioFile.baseUrl, 5);
    expect(analysis.hops).toBe(5);
    expect(analysis.loop).toBe(false);
  });
});

describe("locationMatches", () => {
  it("compares host, path, query and fragment", () => {
    expect(
      locationMatches(
        "https://example.test/care/",
        "https://example.test/care/",
        scenarioFile.baseUrl,
      ),
    ).toBe(true);
    expect(
      locationMatches(
        "https://example.test/care/",
        "https://example.test/care",
        scenarioFile.baseUrl,
      ),
    ).toBe(false);
  });

  it("rejects a missing Location", () => {
    expect(locationMatches("/care/", null, scenarioFile.baseUrl)).toBe(false);
  });
});

describe("buildRedirectMap — proven, one hop, resolving", () => {
  it("verifies a healthy map", () => {
    const map = build("healthy");
    expect(map.count).toBe(2);
    expect(map.verified).toBe(2);
    expect(map.broken).toEqual([]);
    expect(map.chains).toEqual([]);
    expect(map.loops).toEqual([]);
  });

  it("flags a two-hop chain and reports the whole path", () => {
    const map = build("chain");
    expect(map.chains).toHaveLength(1);
    const chained = map.chains[0];
    expect(chained?.from).toBe("/a");
    expect(chained?.hops).toBe(2);
    expect(chained?.problems).toContain("chain");
    expect(chained?.verified).toBe(false);
  });

  it("flags a loop once, without also calling it a chain", () => {
    const map = build("loop");
    expect(map.chains).toEqual([]);
    expect(map.loops).toHaveLength(2);
    expect(map.loops[0]?.problems).toContain("loop");
    expect(map.loops[0]?.problems).not.toContain("chain");
    expect(map.loops[0]?.verified).toBe(false);
  });

  it("flags a destination that answers 404", () => {
    const map = build("target-error");
    expect(map.broken[0]?.problems).toContain("target-error");
    expect(map.broken[0]?.finalStatus).toBe(404);
  });

  it("flags a live Location that disagrees with the recorded map", () => {
    const map = build("arrival-mismatch");
    expect(map.broken[0]?.problems).toContain("arrival-mismatch");
  });

  it("flags a redirect to itself", () => {
    expect(build("self").broken[0]?.problems).toContain("self-redirect");
  });

  it("flags a non-301 code, because the site's contract is permanent redirects", () => {
    expect(build("not-301").broken[0]?.problems).toContain("not-301");
  });

  it("records an unprobed redirect as unverified instead of dropping it", () => {
    const map = buildRedirectMap({
      baseUrl: scenarioFile.baseUrl,
      entries: [{ from: "/unprobed", to: "/care/", code: 301 }],
    });
    expect(map.count).toBe(1);
    expect(map.broken[0]?.problems).toEqual(["unverified"]);
    expect(map.broken[0]?.finalStatus).toBeNull();
  });
});

describe("toCloudflareRedirects", () => {
  it("emits verified entries only, keeping the external destination absolute", () => {
    const lines = toCloudflareRedirects(build("healthy"));
    expect(lines).toEqual([
      "/apply https://example.test/?fluent-form=3 301",
      "/bylaws https://drive.example.com/file/abc/view 301",
    ]);
  });

  it("emits nothing for a fully broken map", () => {
    expect(toCloudflareRedirects(build("loop"))).toEqual([]);
  });
});

describe("the real captured redirect map (capture/routes.manifest.json)", () => {
  const manifestPath = join(import.meta.dirname, "..", "capture", "routes.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    baseUrl: string;
    discovery: { redirects: RedirectEntry[] };
  };
  const entries = manifest.discovery.redirects;
  const map = new Map(entries.map((entry) => [entry.from, entry]));

  it("holds the 11 proven 301s", () => {
    expect(entries).toHaveLength(11);
    expect(entries.every((entry) => entry.code === 301)).toBe(true);
  });

  it("has no redirect whose destination is itself a redirect source (chain-free by construction)", () => {
    const chained = entries.filter((entry) => {
      const target = sitePathOf(entry.to, manifest.baseUrl);
      return target !== null && map.has(target);
    });
    expect(chained).toEqual([]);
    for (const entry of entries) {
      expect(analyseChain(entry, map, manifest.baseUrl).hops).toBe(1);
    }
  });

  it("has no duplicate source path (one map entry per old URL)", () => {
    expect(new Set(entries.map((entry) => entry.from)).size).toBe(entries.length);
  });

  it("classifies the six external destinations and the five internal ones", () => {
    const external = entries.filter((entry) => isExternal(entry.to, manifest.baseUrl));
    expect(external.map((entry) => entry.from).sort()).toEqual([
      "/mlm/bylaws",
      "/mlm/join-signal",
      "/mlm/orientation",
      "/tmh/bylaws",
      "/tmh/join-signal",
      "/tmh/orientation",
    ]);
    expect(entries.length - external.length).toBe(5);
  });
});
