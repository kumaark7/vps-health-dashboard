const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const tls = require("node:tls");

const execFileAsync = promisify(execFile);
const rootDir = __dirname;
const storageScriptPath = path.join(rootDir, "remote-storage-summary.js");
const stateDirPath = path.join(rootDir, "data");
const alertStatePath = path.join(stateDirPath, "monitor-state.json");
const publicFiles = new Set(["/index.html", "/styles.css", "/script.js", "/login.html", "/login.js"]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function loadEnvFile() {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const parsed = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"|"$/g, "");
    parsed[key] = value;
  }

  return parsed;
}

function getEnv() {
  return {
    ...loadEnvFile(),
    ...process.env
  };
}

function normalizeMultilineValue(value) {
  if (!value) {
    return value;
  }

  return value.replace(/\\n/g, "\n").trim();
}

async function ensureSshKeyFile(env) {
  if (env.VPS_SSH_KEY_PATH) {
    return env.VPS_SSH_KEY_PATH;
  }

  if (!env.VPS_SSH_PRIVATE_KEY) {
    return null;
  }

  const normalizedKey = normalizeMultilineValue(env.VPS_SSH_PRIVATE_KEY);
  const keyFilePath = path.join(os.tmpdir(), "vps-health-dashboard-render-key");
  await fsp.writeFile(keyFilePath, `${normalizedKey}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return keyFilePath;
}

function loadMonitorConfig() {
  const configPath = path.join(rootDir, "config", "monitors.json");
  const fallbackPath = path.join(rootDir, "config", "monitors.example.json");
  const targetPath = fs.existsSync(configPath) ? configPath : fallbackPath;
  return JSON.parse(fs.readFileSync(targetPath, "utf8"));
}

function getSessionSecret(env) {
  return env.SESSION_SECRET || "local-dashboard-session-secret";
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie || "";
  return cookieHeader.split(";").reduce((cookies, chunk) => {
    const [rawKey, ...rawValue] = chunk.trim().split("=");
    if (!rawKey) {
      return cookies;
    }

    cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
    return cookies;
  }, {});
}

function createSessionToken(username, env) {
  const payload = JSON.stringify({
    username,
    expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000)
  });
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", getSessionSecret(env))
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token, env) {
  if (!token || !token.includes(".")) {
    return null;
  }

  const [encodedPayload, providedSignature] = token.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", getSessionSecret(env))
    .update(encodedPayload)
    .digest("base64url");

  if (providedSignature !== expectedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload.expiresAt || payload.expiresAt < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function isAuthenticated(request, env) {
  if (!env.AUTH_USERNAME || !env.AUTH_PASSWORD) {
    return true;
  }

  const cookies = parseCookies(request);
  const session = verifySessionToken(cookies.dashboard_session, env);
  return Boolean(session && session.username === env.AUTH_USERNAME);
}

function buildCookie(name, value, maxAgeSeconds) {
  const cookieParts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (process.env.RENDER || process.env.NODE_ENV === "production") {
    cookieParts.push("Secure");
  }

  return cookieParts.join("; ");
}

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function jsonResponse(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": contentTypes[".json"],
    ...extraHeaders
  });
  response.end(JSON.stringify(payload, null, 2));
}

function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

async function readAlertState() {
  try {
    const raw = await fsp.readFile(alertStatePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { services: {} };
  }
}

async function writeAlertState(state) {
  await fsp.mkdir(stateDirPath, { recursive: true });
  await fsp.writeFile(alertStatePath, JSON.stringify(state, null, 2), "utf8");
}

async function sendDiscordAlert(env, service, previousStatus) {
  if (!env.DISCORD_WEBHOOK_URL) {
    return;
  }

  const isRecovery = service.status === "online";
  const content = isRecovery
    ? `🟢 ${service.name} recovered\nURL: ${service.url}\nStatus: ${service.statusLabel}\nLatency: ${service.latencyLabel}`
    : `🔴 ${service.name} is down\nURL: ${service.url}\nPrevious: ${previousStatus || "unknown"}\nCurrent: ${service.statusLabel}`;

  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content })
    });
  } catch {
    // Swallow alert transport errors so monitoring still works.
  }
}

async function notifyMonitorChanges(env, services) {
  const alertableServices = services.filter((service) => service.type === "website");
  const state = await readAlertState();
  const nextState = { services: { ...state.services } };

  for (const service of alertableServices) {
    const previousStatus = state.services[service.id];
    if (previousStatus && previousStatus !== service.status) {
      await sendDiscordAlert(env, service, previousStatus);
    }

    nextState.services[service.id] = service.status;
  }

  await writeAlertState(nextState);
}

async function readSslDays(targetUrl) {
  const parsedUrl = new URL(targetUrl);
  if (parsedUrl.protocol !== "https:") {
    return null;
  }

  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: parsedUrl.hostname,
        port: Number(parsedUrl.port || 443),
        servername: parsedUrl.hostname,
        timeout: 7000
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || !cert.valid_to) {
          resolve(null);
          return;
        }

        const remainingMs = new Date(cert.valid_to).getTime() - Date.now();
        resolve(Math.max(0, Math.ceil(remainingMs / 86400000)));
      }
    );

    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function probeWebsite(service) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.timeoutMs || 8000);
  const startedAt = Date.now();

  try {
    const response = await fetch(service.url, {
      method: service.method || "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "vps-health-dashboard/1.0"
      }
    });

    clearTimeout(timer);

    const latencyMs = Date.now() - startedAt;
    const sslDays = await readSslDays(service.url);
    const status = response.ok ? "online" : "error";

    return {
      id: service.id,
      name: service.name,
      type: service.type || "website",
      url: service.url,
      status,
      statusLabel: response.ok ? "Online" : `HTTP ${response.status}`,
      latencyMs,
      latencyLabel: `${latencyMs} ms`,
      sslDays,
      sslLabel: sslDays == null ? "N/A" : `${sslDays} days`
    };
  } catch (error) {
    clearTimeout(timer);

    return {
      id: service.id,
      name: service.name,
      type: service.type || "website",
      url: service.url,
      status: "error",
      statusLabel: "Offline",
      latencyMs: null,
      latencyLabel: error.name === "AbortError" ? "Timeout" : "Error",
      sslDays: null,
      sslLabel: "N/A"
    };
  }
}

function parseKeyValueOutput(stdout) {
  const parsed = {};
  for (const line of stdout.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    parsed[key] = value;
  }

  return parsed;
}

function buildSshArgs(env) {
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ];

  if (env.VPS_PORT) {
    sshArgs.push("-p", env.VPS_PORT);
  }

  if (env._resolvedKeyPath) {
    sshArgs.push("-i", env._resolvedKeyPath);
  }

  return sshArgs;
}

async function runRemoteCommand(env, command) {
  const sshArgs = buildSshArgs(env);
  sshArgs.push(`${env.VPS_USER}@${env.VPS_HOST}`, command);

  return execFileAsync("ssh", sshArgs, {
    cwd: rootDir,
    timeout: 45000,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8
  });
}

async function probeServer(env) {
  if (!env.VPS_HOST || !env.VPS_USER) {
    return {
      connected: false,
      hostLabel: "Not configured",
      message: "Missing VPS_HOST or VPS_USER in `.env`."
    };
  }

  const remoteScript = [
    "cpu_percent=$(top -bn1 | awk '/Cpu\\(s\\)/ {printf \"%.0f\", 100 - $8}')",
    "mem_total=$(free -m | awk '/Mem:/ {print $2}')",
    "mem_used=$(free -m | awk '/Mem:/ {print $3}')",
    "memory_percent=$(free | awk '/Mem:/ {printf \"%.0f\", ($3/$2)*100}')",
    "disk_percent=$(df -Pm / | awk 'NR==2 {gsub(/%/, \"\", $5); print $5}')",
    "disk_free=$(df -Pm / | awk 'NR==2 {print $4}')",
    "uptime_value=$(uptime -p)",
    "load_average=$(cut -d\" \" -f1 /proc/loadavg)",
    "printf 'cpu_percent=%s\\n' \"$cpu_percent\"",
    "printf 'memory_total_mb=%s\\n' \"$mem_total\"",
    "printf 'memory_used_mb=%s\\n' \"$mem_used\"",
    "printf 'memory_percent=%s\\n' \"$memory_percent\"",
    "printf 'disk_used_percent=%s\\n' \"$disk_percent\"",
    "printf 'disk_free_mb=%s\\n' \"$disk_free\"",
    "printf 'uptime=%s\\n' \"$uptime_value\"",
    "printf 'load_average=%s\\n' \"$load_average\""
  ].join("; ");

  const encodedScript = Buffer.from(remoteScript, "utf8").toString("base64");

  try {
    const { stdout } = await runRemoteCommand(
      env,
      `bash -lc "$(printf '%s' '${encodedScript}' | base64 -d)"`
    );

    const parsed = parseKeyValueOutput(stdout);
    const memoryTotalGb = (Number(parsed.memory_total_mb || 0) / 1024).toFixed(1);
    const memoryUsedGb = (Number(parsed.memory_used_mb || 0) / 1024).toFixed(1);
    const diskFreeGb = (Number(parsed.disk_free_mb || 0) / 1024).toFixed(1);

    return {
      connected: true,
      hostLabel: env.VPS_HOST,
      metrics: {
        cpuPercent: Math.round(Number(parsed.cpu_percent || 0)),
        memoryPercent: Math.round(Number(parsed.memory_percent || 0)),
        memoryTotalGb,
        memoryUsedGb,
        diskUsedPercent: Math.round(Number(parsed.disk_used_percent || 0)),
        diskFreeGb,
        uptime: parsed.uptime || "Unknown",
        loadAverage: parsed.load_average || "--"
      }
    };
  } catch (error) {
    return {
      connected: false,
      hostLabel: env.VPS_HOST,
      message: "SSH connection failed. Check host, user, key path, and firewall."
    };
  }
}

function getStorageUnavailable(reason) {
  return {
    available: false,
    message: reason,
    fileRoot: null,
    totalSpace: 0,
    usedSpace: 0,
    availableSpace: 0,
    categories: {
      documents: 0,
      images: 0,
      videos: 0,
      others: 0
    },
    projects: [],
    topProjects: []
  };
}

async function probeStorage(env, serverState) {
  if (!serverState.connected) {
    return getStorageUnavailable(serverState.message || "SSH must be connected first.");
  }

  const scriptBody = fs.readFileSync(storageScriptPath, "utf8");
  const encodedScript = Buffer.from(scriptBody, "utf8").toString("base64");
  const fileRoot = env.VPS_FILE_ROOT || "/home/ubuntu";

  try {
    const { stdout } = await runRemoteCommand(
      env,
      `FILE_ROOT='${fileRoot}' node -e "eval(Buffer.from(process.argv[1],'base64').toString())" '${encodedScript}'`
    );

    const parsed = JSON.parse(stdout);
    return {
      available: true,
      ...parsed
    };
  } catch (error) {
    return getStorageUnavailable("Storage scan failed. Make sure Node is installed on the VPS and the file root exists.");
  }
}

async function buildDashboard() {
  const env = getEnv();
  env._resolvedKeyPath = await ensureSshKeyFile(env);
  const config = loadMonitorConfig();
  const services = await Promise.all(
    (config.services || []).map((service) => {
      if (service.type === "private") {
        return Promise.resolve({
          id: service.id,
          name: service.name,
          type: "private",
          status: "private",
          statusLabel: "Private",
          latencyMs: null,
          latencyLabel: service.note || "Internal",
          sslDays: null,
          sslLabel: "N/A"
        });
      }

      return probeWebsite(service);
    })
  );

  const averageLatencyMs = Math.round(
    services
      .filter((service) => typeof service.latencyMs === "number")
      .reduce((sum, service, _, list) => sum + service.latencyMs / list.length, 0)
  ) || null;

  const server = await probeServer(env);
  const storage = await probeStorage(env, server);
  await notifyMonitorChanges(env, services);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      averageLatencyMs
    },
    server,
    storage,
    services
  };
}

async function sendJson(response, statusCode, payload) {
  jsonResponse(response, statusCode, payload);
}

async function serveStatic(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  if (!publicFiles.has(normalizedPath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const filePath = path.join(rootDir, normalizedPath);
  const extension = path.extname(filePath);
  const content = await fsp.readFile(filePath);
  response.writeHead(200, { "content-type": contentTypes[extension] || "application/octet-stream" });
  response.end(content);
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const env = getEnv();
    const authenticated = isAuthenticated(request, env);

    if (requestUrl.pathname === "/api/login" && request.method === "POST") {
      const body = await readRequestBody(request);
      const parsedBody = JSON.parse(body || "{}");

      if (!env.AUTH_USERNAME || !env.AUTH_PASSWORD) {
        await sendJson(response, 200, { ok: true, authEnabled: false });
        return;
      }

      if (parsedBody.username === env.AUTH_USERNAME && parsedBody.password === env.AUTH_PASSWORD) {
        const token = createSessionToken(parsedBody.username, env);
        jsonResponse(
          response,
          200,
          { ok: true },
          { "set-cookie": buildCookie("dashboard_session", token, 7 * 24 * 60 * 60) }
        );
        return;
      }

      await sendJson(response, 401, { ok: false, message: "Invalid username or password." });
      return;
    }

    if (requestUrl.pathname === "/api/logout" && request.method === "POST") {
      jsonResponse(
        response,
        200,
        { ok: true },
        { "set-cookie": buildCookie("dashboard_session", "", 0) }
      );
      return;
    }

    if (requestUrl.pathname === "/api/auth") {
      await sendJson(response, 200, {
        authenticated,
        authEnabled: Boolean(env.AUTH_USERNAME && env.AUTH_PASSWORD)
      });
      return;
    }

    if (requestUrl.pathname === "/login" && (!env.AUTH_USERNAME || !env.AUTH_PASSWORD)) {
      redirect(response, "/");
      return;
    }

    if (requestUrl.pathname === "/login") {
      await serveStatic("/login.html", response);
      return;
    }

    if (!authenticated && requestUrl.pathname.startsWith("/api/")) {
      await sendJson(response, 401, { error: "Authentication required" });
      return;
    }

    if (!authenticated && requestUrl.pathname !== "/styles.css" && requestUrl.pathname !== "/login.js") {
      redirect(response, "/login");
      return;
    }

    if (requestUrl.pathname === "/api/dashboard") {
      const dashboard = await buildDashboard();
      await sendJson(response, 200, dashboard);
      return;
    }

    if (requestUrl.pathname === "/api/storage") {
      env._resolvedKeyPath = await ensureSshKeyFile(env);
      const serverState = await probeServer(env);
      const storage = await probeStorage(env, serverState);
      await sendJson(response, 200, storage);
      return;
    }

    await serveStatic(requestUrl.pathname, response);
  } catch (error) {
    await sendJson(response, 500, {
      error: "Dashboard server failed",
      details: error.message
    });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Dashboard ready at http://localhost:${port}`);
});
