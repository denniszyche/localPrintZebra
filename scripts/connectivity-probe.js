#!/usr/bin/env node

/*
Simple connectivity probe for external firewall/NAT diagnostics.
- Repeats HTTP and TCP checks against target host/port
- Emits one JSON log line per cycle
- Optional output file for sharing with IT/firewall teams
*/

const fs = require("fs");
const net = require("net");
const path = require("path");

function getArg(name, fallback = null) {
    // Use the last matching flag so callers can override defaults from npm scripts.
    for (let idx = process.argv.length - 1; idx >= 0; idx -= 1) {
        if (process.argv[idx] === `--${name}` && idx + 1 < process.argv.length) {
            return process.argv[idx + 1];
        }
    }
    return fallback;
}

function getNumberArg(name, fallback) {
    const raw = getArg(name, null);
    if (raw === null || raw === undefined || raw === "") {
        return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function isoNow() {
    return new Date().toISOString();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function tcpProbe(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const startedAt = Date.now();
        let settled = false;

        function done(result) {
            if (settled) {
                return;
            }
            settled = true;
            try {
                socket.destroy();
            } catch (_) {
                // Ignore destroy errors.
            }
            resolve({
                ...result,
                durationMs: Date.now() - startedAt,
            });
        }

        socket.setTimeout(timeoutMs);

        socket.once("connect", () => {
            done({ ok: true, status: "open", error: null });
        });

        socket.once("timeout", () => {
            done({ ok: false, status: "timeout", error: "TCP timeout" });
        });

        socket.once("error", (err) => {
            done({
                ok: false,
                status: "error",
                error: err && err.message ? err.message : "TCP error",
            });
        });

        socket.connect(port, host);
    });
}

async function httpProbe(url, timeoutMs, extraHeaders) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
        const response = await fetch(url, {
            method: "GET",
            headers: extraHeaders,
            signal: controller.signal,
        });
        const text = await response.text();

        return {
            ok: response.ok,
            statusCode: response.status,
            bodyPreview: String(text || "").slice(0, 240),
            durationMs: Date.now() - startedAt,
            error: null,
        };
    } catch (err) {
        return {
            ok: false,
            statusCode: null,
            bodyPreview: "",
            durationMs: Date.now() - startedAt,
            error: err && err.message ? err.message : "HTTP request failed",
        };
    } finally {
        clearTimeout(timer);
    }
}

function buildHeaders(runId) {
    return {
        "User-Agent": "localPrintZebra-connectivity-probe/1.0",
        "X-Debug-Probe": "telmex-firewall-test",
        "X-Probe-Run-Id": runId,
    };
}

function appendLogLine(outputFile, line) {
    if (!outputFile) {
        return;
    }

    fs.appendFileSync(outputFile, line + "\n", "utf8");
}

function sanitizeHost(host) {
    if (!host) {
        return "187.170.149.5";
    }
    return String(host).trim();
}

function sanitizePath(p) {
    if (!p) {
        return "/health";
    }
    const raw = String(p).trim();
    if (!raw.startsWith("/")) {
        return `/${raw}`;
    }
    return raw;
}

async function main() {
    const host = sanitizeHost(
        getArg("host", process.env.PROBE_HOST || "187.170.149.5"),
    );
    const port = getNumberArg("port", Number(process.env.PROBE_PORT || 3001));
    const healthPath = sanitizePath(
        getArg("path", process.env.PROBE_PATH || "/health"),
    );
    const intervalMs = getNumberArg(
        "intervalMs",
        Number(process.env.PROBE_INTERVAL_MS || 10000),
    );
    const timeoutMs = getNumberArg(
        "timeoutMs",
        Number(process.env.PROBE_TIMEOUT_MS || 8000),
    );
    const durationSec = getNumberArg(
        "durationSec",
        Number(process.env.PROBE_DURATION_SEC || 1800),
    );
    const outputFileArg = getArg("output", process.env.PROBE_OUTPUT_FILE || "");
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid port: ${port}`);
    }

    if (!Number.isFinite(intervalMs) || intervalMs < 250) {
        throw new Error(`Invalid intervalMs: ${intervalMs}`);
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs < 250) {
        throw new Error(`Invalid timeoutMs: ${timeoutMs}`);
    }

    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error(`Invalid durationSec: ${durationSec}`);
    }

    const outputFile = outputFileArg ? path.resolve(outputFileArg) : "";
    const targetUrl = `http://${host}:${port}${healthPath}`;
    const headers = buildHeaders(runId);
    const startedAt = Date.now();
    const endAt = startedAt + durationSec * 1000;

    const startup = {
        ts: isoNow(),
        level: "info",
        type: "startup",
        runId,
        host,
        port,
        healthPath,
        targetUrl,
        intervalMs,
        timeoutMs,
        durationSec,
        outputFile: outputFile || null,
    };
    const startupLine = JSON.stringify(startup);
    console.log(startupLine);
    appendLogLine(outputFile, startupLine);

    let cycle = 0;
    while (Date.now() < endAt) {
        cycle += 1;

        const [tcp, http] = await Promise.all([
            tcpProbe(host, port, timeoutMs),
            httpProbe(targetUrl, timeoutMs, headers),
        ]);

        const lineObj = {
            ts: isoNow(),
            level: "info",
            type: "probe",
            runId,
            cycle,
            host,
            port,
            url: targetUrl,
            tcp,
            http,
        };
        const line = JSON.stringify(lineObj);

        console.log(line);
        appendLogLine(outputFile, line);

        await sleep(intervalMs);
    }

    const summary = {
        ts: isoNow(),
        level: "info",
        type: "done",
        runId,
        cycles: cycle,
        durationSec,
    };
    const summaryLine = JSON.stringify(summary);
    console.log(summaryLine);
    appendLogLine(outputFile, summaryLine);
}

main().catch((err) => {
    const line = JSON.stringify({
        ts: isoNow(),
        level: "error",
        type: "fatal",
        error: err && err.message ? err.message : String(err),
    });
    console.error(line);
    process.exitCode = 1;
});
