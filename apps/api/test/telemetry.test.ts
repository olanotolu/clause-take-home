import { describe, expect, it } from "vitest";
import { flushTelemetryBounded, initTelemetry, instrumentStore, parseOtlpHeaders, recordAi, recordAiError, recordBlob, recordDb, recordRoute, recordWebVital, registerPool, runtimeDiagnostics } from "../src/telemetry.ts";

describe("runtime diagnostics",()=>{
  it("identifies this process instance and its start time",()=>{
    const diagnostics=runtimeDiagnostics();
    expect(diagnostics.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Number.isNaN(Date.parse(diagnostics.instanceStartedAt))).toBe(false);
    expect(diagnostics.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(diagnostics.region===null||/^[a-z0-9]+$/.test(diagnostics.region)).toBe(true);
  });
});

describe("OTLP authentication headers",()=>{
  it("parses encoded collector credentials and rejects malformed values",()=>{
    expect(parseOtlpHeaders("authorization=Bearer%20collector-token,x-api-key=abc123")).toEqual({authorization:"Bearer collector-token","x-api-key":"abc123"});
    expect(parseOtlpHeaders(undefined)).toBeUndefined();
    expect(()=>parseOtlpHeaders("authorization=%0d%0aInjected:value")).toThrow("Invalid OTLP header configuration");
    expect(()=>parseOtlpHeaders("not-a-header")).toThrow("Invalid OTLP header configuration");
    expect(()=>parseOtlpHeaders("x-key=one,x-key=two")).toThrow("Invalid OTLP header configuration");
    expect(()=>parseOtlpHeaders("Authorization=one,authorization=two")).toThrow("Invalid OTLP header configuration");
  });
});

describe("telemetry without an exporter configured", () => {
  it("accepts bounded, non-sensitive measurements without changing application behavior", async () => {
    initTelemetry({});
    registerPool({ kind: "sqlite", waitingCount: 0, totalCount: 1, idleCount: 1 });
    recordRoute({ method: "GET", route: "/documents/:id", status: 200, durationMs: 12 });
    recordDb("sqlite", "getDocumentMetadata", 2, false);
    recordDb("postgres", "getRevision", 4, true);
    recordAi("test-model", { inputTokens: 12, outputTokens: 3 }, 0.001, false, 20);
    recordAi("test-model", undefined, Number.NaN, true);
    recordAiError("test-model", 30);
    recordBlob("read", 5, 100, false);
    recordBlob("upload", 10, 0, true);
    recordWebVital("INP", 120);
    recordWebVital("LCP", Number.NaN);
    recordWebVital("CLS", -1);
    await flushTelemetryBounded(5);

    const calls: string[] = [];
    const store = instrumentStore({ kind: "sqlite", close() { calls.push("close"); }, async read() { calls.push("read"); return 7; }, async fail() { calls.push("fail"); throw new Error("expected"); } });
    expect(await store.read()).toBe(7);
    await expect(store.fail()).rejects.toThrow("expected");
    expect(store.close()).toBeUndefined();
    expect(calls).toEqual(["read", "fail", "close"]);
  });
});
