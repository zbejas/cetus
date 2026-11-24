import { describe, expect, test } from "bun:test";
import { dependentServices } from "./autoUpdateRunner.ts";

describe("dependent services", () => {
  test("finds services that share a network namespace", () => {
    const services = {
      gluetun: { image: "qmcgaw/gluetun" },
      qbittorrent: { image: "linuxserver/qbittorrent", network_mode: "service:gluetun" },
      sonarr: { image: "linuxserver/sonarr", network_mode: "service:gluetun" },
      other: { image: "nginx" },
    };
    expect(dependentServices(services, ["gluetun"]).sort()).toEqual(["qbittorrent", "sonarr"]);
  });

  test("finds depends_on in list and map form", () => {
    expect(dependentServices({
      db: { image: "postgres" },
      cache: { image: "redis" },
      app: { image: "app", depends_on: ["db"] },
      worker: { image: "worker", depends_on: { cache: { condition: "service_healthy" } } },
    }, ["db", "cache"]).sort()).toEqual(["app", "worker"]);
  });

  test("finds volumes_from and links", () => {
    expect(dependentServices({
      source: { image: "source" },
      volumeUser: { image: "app", volumes_from: ["source:ro"] },
      linked: { image: "app", links: ["source:alias"] },
      external: { image: "app", volumes_from: ["container:something"] },
    }, ["source"]).sort()).toEqual(["linked", "volumeUser"]);
  });

  test("ignores selected services and unrelated stacks", () => {
    expect(dependentServices({ a: { image: "a" }, b: { image: "b" } }, ["a"])).toEqual([]);
  });
});
