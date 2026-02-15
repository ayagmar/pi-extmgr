const CONFIG = {
  npmPackage: "pi-extmgr",
  githubRepo: "ayagmar/pi-extmgr",
  fallbackVersion: "0.1.14",
};

// Format numbers with commas
const formatNumber = (n) => n?.toLocaleString() ?? "—";

// Update element with fade animation
const updateStat = (id, value) => {
  const el = document.getElementById(id);
  if (!el || value === null) return;
  el.textContent = value;
  el.classList.add("stat-loaded");
};

// Fetch npm weekly downloads
async function fetchNpmDownloads() {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${CONFIG.npmPackage}`);
    if (!res.ok) throw new Error("npm API failed");
    const data = await res.json();
    updateStat("npm-downloads", formatNumber(data.downloads));
  } catch (err) {
    console.log("npm downloads unavailable");
  }
}

// Fetch GitHub stars
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

// Fetch latest version from npm
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

// Load all stats when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  fetchNpmDownloads();
  fetchGitHubStars();
  fetchLatestVersion();
});
