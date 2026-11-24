import { describe, expect, test } from "bun:test";
import { parseBytes, parseJsonArray, parseJsonLines, parseLabels } from "./docker.ts";

describe("docker parsing", () => {
  test("parses line-delimited json and arrays", () => {
    expect(parseJsonLines('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseJsonArray('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseJsonArray('{"a":1}')).toEqual([{ a: 1 }]);
  });

  test("parses compose labels", () => {
    expect(parseLabels("com.docker.compose.project=app,com.docker.compose.service=web")).toEqual({
      "com.docker.compose.project": "app",
      "com.docker.compose.service": "web",
    });
    expect(parseLabels("")).toEqual({});
  });

  test("parses human byte units", () => {
    expect(parseBytes("1B")).toBe(1);
    expect(parseBytes("1KB")).toBe(1000);
    expect(parseBytes("1KiB")).toBe(1024);
    expect(parseBytes("6.2MB")).toBe(6_200_000);
  });
});
