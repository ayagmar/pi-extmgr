const CONFIG = {
  npmPackage: "pi-extmgr",
  githubRepo: "ayagmar/pi-extmgr",
  fallbackVersion: "0.1.14",
};

const formatNumber = (n) => n?.toLocaleString() ?? "—";

const updateStat = (id, value) => {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined) return;
  el.textContent = value;
  el.classList.add("stat-loaded");
};

const toDateString = (date) => new Date(date).toISOString().slice(0, 10);

async function fetchNpmWeeklyDownloads() {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${CONFIG.npmPackage}`);
    if (!res.ok) throw new Error("npm weekly API failed");
    const data = await res.json();
    updateStat("npm-downloads-weekly", formatNumber(data.downloads));
  } catch (err) {
    console.log("npm weekly downloads unavailable");
  }
}

async function fetchNpmTotalDownloads() {
  try {
    const pkgRes = await fetch(`https://registry.npmjs.org/${CONFIG.npmPackage}`);
    if (!pkgRes.ok) throw new Error("npm registry package metadata failed");
    const pkgData = await pkgRes.json();

    const createdAt = pkgData?.time?.created;
    if (!createdAt) throw new Error("missing package creation date");

    const start = toDateString(createdAt);
    const end = toDateString(Date.now());

    const downloadsRes = await fetch(
      `https://api.npmjs.org/downloads/point/${start}:${end}/${CONFIG.npmPackage}`
    );
    if (!downloadsRes.ok) throw new Error("npm total downloads API failed");

    const downloadsData = await downloadsRes.json();
    updateStat("npm-downloads-total", formatNumber(downloadsData.downloads));
  } catch (err) {
    console.log("npm total downloads unavailable");
  }
}

async function fetchGitHubStars() {
  try {
    const res = await fetch(`https://api.github.com/repos/${CONFIG.githubRepo}`);
    if (!res.ok) throw new Error("GitHub API failed");
    const data = await res.json();
    updateStat("github-stars", formatNumber(data.stargazers_count));
  } catch (err) {
    console.log("GitHub stars unavailable");
  }
}

async function fetchLatestVersion() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${CONFIG.npmPackage}/latest`);
    if (!res.ok) throw new Error("npm registry failed");
    const data = await res.json();
    updateStat("latest-version", "v" + data.version);
  } catch (err) {
    updateStat("latest-version", "v" + CONFIG.fallbackVersion);
  }
}

function setupLightbox() {
  const lightbox = document.getElementById("lightbox");
  const lightboxImage = document.getElementById("lightbox-image");
  const closeButton = document.getElementById("lightbox-close");
  const triggers = document.querySelectorAll(".lightbox-trigger");

  if (!lightbox || !lightboxImage || !closeButton || triggers.length === 0) return;

  const open = (src, alt) => {
    lightboxImage.src = src;
    lightboxImage.alt = alt ?? "Image preview";
    lightbox.classList.remove("hidden");
    lightbox.classList.add("flex");
    lightbox.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  };

  const close = () => {
    lightbox.classList.add("hidden");
    lightbox.classList.remove("flex");
    lightbox.setAttribute("aria-hidden", "true");
    lightboxImage.src = "";
    document.body.style.overflow = "";
  };

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      open(trigger.dataset.lightboxSrc, trigger.dataset.lightboxAlt);
    });
  });

  closeButton.addEventListener("click", close);

  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !lightbox.classList.contains("hidden")) {
      close();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  fetchNpmWeeklyDownloads();
  fetchNpmTotalDownloads();
  fetchGitHubStars();
  fetchLatestVersion();
  setupLightbox();
});
