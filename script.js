const els = {
  brandMeta: document.querySelector("#brandMeta"),
  introText: document.querySelector("#introText"),
  overallStatus: document.querySelector("#overallStatus"),
  uptimeStat: document.querySelector("#uptimeStat"),
  avgLatencyStat: document.querySelector("#avgLatencyStat"),
  monitorCount: document.querySelector("#monitorCount"),
  cpuRing: document.querySelector("#cpuRing"),
  cpuValue: document.querySelector("#cpuValue"),
  cpuMeta: document.querySelector("#cpuMeta"),
  memoryRing: document.querySelector("#memoryRing"),
  memoryValue: document.querySelector("#memoryValue"),
  memoryMeta: document.querySelector("#memoryMeta"),
  serviceGrid: document.querySelector("#serviceGrid"),
  serviceName: document.querySelector("#serviceName"),
  serviceStatus: document.querySelector("#serviceStatus"),
  serviceHealthBar: document.querySelector("#serviceHealthBar"),
  diskValue: document.querySelector("#diskValue"),
  diskMeta: document.querySelector("#diskMeta"),
  loadValue: document.querySelector("#loadValue"),
  uptimeValue: document.querySelector("#uptimeValue"),
  sslDays: document.querySelector("#sslDays"),
  latencyValue: document.querySelector("#latencyValue"),
  storageMeta: document.querySelector("#storageMeta"),
  storageUsed: document.querySelector("#storageUsed"),
  storageAvailable: document.querySelector("#storageAvailable"),
  storageBarFill: document.querySelector("#storageBarFill"),
  documentsUsage: document.querySelector("#documentsUsage"),
  imagesUsage: document.querySelector("#imagesUsage"),
  videosUsage: document.querySelector("#videosUsage"),
  othersUsage: document.querySelector("#othersUsage"),
  topProjects: document.querySelector("#topProjects"),
  connectionBadge: document.querySelector("#connectionBadge"),
  connectionToggle: document.querySelector("#connectionToggle"),
  connectionMeta: document.querySelector("#connectionMeta"),
  lastUpdated: document.querySelector("#lastUpdated"),
  footerMessage: document.querySelector("#footerMessage"),
  refreshButton: document.querySelector("#refreshButton"),
  logoutButton: document.querySelector("#logoutButton"),
  previousService: document.querySelector("#previousService"),
  nextService: document.querySelector("#nextService")
};

let dashboardState = { services: [] };
let selectedServiceIndex = 0;

function iconForType(type) {
  if (type === "website") {
    return '<svg viewBox="0 0 24 24"><path d="M3.8 12h16.4"/><path d="M12 3.8c3.1 2.9 4.6 5.8 4.6 8.2S15.1 17.3 12 20.2C8.9 17.3 7.4 14.4 7.4 12S8.9 6.7 12 3.8Z"/><path d="M4.9 8.2h14.2M4.9 15.8h14.2"/></svg>';
  }

  if (type === "private") {
    return '<svg viewBox="0 0 24 24"><path d="M7.8 11a4.2 4.2 0 1 1 8.4 0"/><path d="M5.8 10.8h12.4v8.4H5.8z"/><path d="M12 14.2v2.1"/></svg>';
  }

  return '<svg viewBox="0 0 24 24"><path d="M5.4 4.7h13.2v6H5.4zM5.4 13.3h13.2v6H5.4z"/><path d="M8.2 7.7h.1M8.2 16.3h.1M11 7.7h5.4M11 16.3h5.4"/></svg>';
}

function setRing(element, value) {
  element.style.setProperty("--value", `${Math.max(0, Math.min(100, value || 0))}`);
}

function formatLatency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return `${Math.round(value)} ms`;
}

function formatSslDays(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }

  return `${value} days`;
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function healthPercent(service) {
  if (service.status === "online") {
    return 100;
  }

  if (service.status === "private") {
    return 50;
  }

  return 18;
}

function selectService(index) {
  if (!dashboardState.services.length) {
    return;
  }

  selectedServiceIndex = (index + dashboardState.services.length) % dashboardState.services.length;
  const service = dashboardState.services[selectedServiceIndex];

  document.querySelectorAll(".service-tile").forEach((tile, tileIndex) => {
    tile.classList.toggle("active", tileIndex === selectedServiceIndex);
  });

  els.serviceName.textContent = service.name;
  els.serviceStatus.textContent = service.statusLabel;
  els.sslDays.textContent = formatSslDays(service.sslDays);
  els.latencyValue.textContent = service.latencyLabel;
  els.serviceHealthBar.style.width = `${healthPercent(service)}%`;
}

function renderServices(services) {
  els.serviceGrid.innerHTML = "";

  if (!services.length) {
    els.serviceGrid.innerHTML = '<div class="service-tile"><strong>No monitors</strong><small>Add entries in config/monitors.json</small></div>';
    return;
  }

  services.forEach((service, index) => {
    const tile = document.createElement("button");
    tile.className = "service-tile";
    tile.type = "button";

    if (service.status === "error") {
      tile.classList.add("is-error");
    }

    if (service.status === "private") {
      tile.classList.add("is-private");
    }

    tile.innerHTML = `
      ${iconForType(service.type)}
      <strong>${service.name}</strong>
      <span>${service.statusLabel}</span>
      <small>${service.latencyLabel}</small>
    `;

    tile.addEventListener("click", () => selectService(index));
    els.serviceGrid.appendChild(tile);
  });

  selectService(Math.min(selectedServiceIndex, services.length - 1));
}

function renderSummary(data) {
  const healthyCount = data.services.filter((service) => service.status === "online").length;

  els.brandMeta.textContent = `${data.services.length} monitors active`;
  els.overallStatus.textContent = healthyCount === data.services.length && data.services.length ? "Online" : healthyCount ? "Mixed" : "Needs Setup";
  els.uptimeStat.textContent = `${healthyCount}/${data.services.length || 0}`;
  els.avgLatencyStat.textContent = formatLatency(data.summary.averageLatencyMs);
  els.monitorCount.textContent = String(data.services.length);

  if (data.server.connected) {
    els.introText.textContent = `Connected to ${data.server.hostLabel}. Website checks and VPS usage are live.`;
  } else {
    els.introText.textContent = "Website checks are live. Add your SSH details in `.env` to pull VPS usage.";
  }
}

function renderServer(server) {
  if (!server.connected) {
    els.cpuValue.textContent = "--";
    els.memoryValue.textContent = "--";
    els.cpuMeta.textContent = "Waiting for SSH";
    els.memoryMeta.textContent = server.message || "Fill `.env` to enable";
    els.diskValue.textContent = "--";
    els.diskMeta.textContent = server.message || "No SSH data yet";
    els.loadValue.textContent = "--";
    els.uptimeValue.textContent = "Waiting for server";
    els.connectionBadge.textContent = "Not Connected";
    els.connectionMeta.textContent = server.message || "Add SSH details in `.env`";
    els.connectionToggle.checked = false;
    setRing(els.cpuRing, 0);
    setRing(els.memoryRing, 0);
    return;
  }

  els.cpuValue.textContent = `${server.metrics.cpuPercent}%`;
  els.memoryValue.textContent = `${server.metrics.memoryPercent}%`;
  els.cpuMeta.textContent = `${server.metrics.loadAverage} load average`;
  els.memoryMeta.textContent = `${server.metrics.memoryUsedGb} GB of ${server.metrics.memoryTotalGb} GB used`;
  els.diskValue.textContent = `${server.metrics.diskUsedPercent}%`;
  els.diskMeta.textContent = `${server.metrics.diskFreeGb} GB free`;
  els.loadValue.textContent = server.metrics.loadAverage;
  els.uptimeValue.textContent = server.metrics.uptime;
  els.connectionBadge.textContent = "Connected";
  els.connectionMeta.textContent = `${server.hostLabel} via SSH`;
  els.connectionToggle.checked = true;
  setRing(els.cpuRing, server.metrics.cpuPercent);
  setRing(els.memoryRing, server.metrics.memoryPercent);
}

function renderFooter(data) {
  const checkedAt = new Date(data.generatedAt);
  els.lastUpdated.textContent = `Last checked at ${checkedAt.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
  els.footerMessage.textContent = data.server.connected
    ? "Private metrics are coming from your local server bridge."
    : "Website checks are working. VPS usage needs SSH setup.";
}

function renderStorage(storage) {
  if (!storage || !storage.available) {
    els.storageMeta.textContent = storage?.message || "Storage data is not available yet.";
    els.storageUsed.textContent = "--";
    els.storageAvailable.textContent = "Available: --";
    els.storageBarFill.style.width = "0%";
    els.documentsUsage.textContent = "--";
    els.imagesUsage.textContent = "--";
    els.videosUsage.textContent = "--";
    els.othersUsage.textContent = "--";
    els.topProjects.innerHTML = '<div class="project-row"><div><strong>Storage scan unavailable</strong><small>SSH must connect before the VPS can scan files.</small></div><span>--</span></div>';
    return;
  }

  const usedPercent = storage.totalSpace ? Math.round((storage.usedSpace / storage.totalSpace) * 100) : 0;
  els.storageMeta.textContent = `Monitoring ${storage.fileRoot}`;
  els.storageUsed.textContent = `${formatBytes(storage.usedSpace)} (${usedPercent}%)`;
  els.storageAvailable.textContent = `Available: ${formatBytes(storage.availableSpace)} of ${formatBytes(storage.totalSpace)}`;
  els.storageBarFill.style.width = `${usedPercent}%`;
  els.documentsUsage.textContent = formatBytes(storage.categories.documents);
  els.imagesUsage.textContent = formatBytes(storage.categories.images);
  els.videosUsage.textContent = formatBytes(storage.categories.videos);
  els.othersUsage.textContent = formatBytes(storage.categories.others);

  if (!storage.topProjects.length) {
    els.topProjects.innerHTML = '<div class="project-row"><div><strong>No files found</strong><small>The monitored root is empty.</small></div><span>0 B</span></div>';
    return;
  }

  els.topProjects.innerHTML = storage.topProjects.map((project) => `
    <div class="project-row">
      <div>
        <strong>${project.name}</strong>
        <small>${project.path}</small>
      </div>
      <span>${formatBytes(project.size)}</span>
    </div>
  `).join("");
}

async function refreshDashboard() {
  els.refreshButton.disabled = true;

  try {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const data = await response.json();
    dashboardState = data;

    renderSummary(data);
    renderServices(data.services);
    renderServer(data.server);
    renderStorage(data.storage);
    renderFooter(data);
  } catch (error) {
    els.overallStatus.textContent = "Offline";
    els.footerMessage.textContent = `Dashboard API error: ${error.message}`;
  } finally {
    els.refreshButton.disabled = false;
  }
}

els.refreshButton.addEventListener("click", refreshDashboard);
els.logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});
els.previousService.addEventListener("click", () => selectService(selectedServiceIndex - 1));
els.nextService.addEventListener("click", () => selectService(selectedServiceIndex + 1));

refreshDashboard();
setInterval(refreshDashboard, 60000);
