const pairSelect = document.getElementById("pairSelect");
const riskSelect = document.getElementById("riskSelect");
const pairSearch = document.getElementById("pairSearch");
const dexCheckboxes = document.querySelectorAll(".dex-filters input[type=checkbox]");
const tableBody = document.getElementById("opportunityTableBody");
const topOpportunityBody = document.getElementById("topOpportunityBody");
const themeToggle = document.getElementById("toggleTheme");

let allData = {};

// Theme init
const currentTheme = localStorage.getItem("theme") || "light";
document.documentElement.setAttribute("data-theme", currentTheme);

themeToggle.addEventListener("click", () => {
  const newTheme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", newTheme);
  localStorage.setItem("theme", newTheme);
});

async function fetchData() {
  try {
    const res = await fetch("https://api.your.site");
    const json = await res.json();
    allData = json.result.table || {};

    populatePairs();
    renderAll();
  } catch (err) {
    console.error("❌ Fetch error:", err);
    tableBody.innerHTML = `<tr><td colspan="5">Error loading data</td></tr>`;
    topOpportunityBody.innerHTML = `<tr><td colspan="5">Error loading top opportunity</td></tr>`;
  }
}

function populatePairs() {
  pairSelect.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "ALL";
  optAll.textContent = "All";
  pairSelect.appendChild(optAll);

  Object.keys(allData).forEach((pair) => {
    const opt = document.createElement("option");
    opt.value = pair;
    opt.textContent = pair;
    pairSelect.appendChild(opt);
  });
}

function getSelectedDEXs() {
  return Array.from(dexCheckboxes).filter((cb) => cb.checked).map((cb) => cb.value);
}

function filterOpportunities() {
  const selectedPair = pairSelect.value;
  const selectedRisk = riskSelect.value;
  const selectedDEXs = getSelectedDEXs();
  const searchText = pairSearch.value.toLowerCase();

  let results = [];

  Object.entries(allData).forEach(([pair, opportunities]) => {
    if (selectedPair !== "ALL" && pair !== selectedPair) return;
    if (searchText && !pair.toLowerCase().includes(searchText)) return;

    opportunities.forEach((opp) => {
      if (
        opp.net_apr > 5 &&
        selectedDEXs.includes(opp.long_dex) &&
        selectedDEXs.includes(opp.short_dex) &&
        (selectedRisk === "ALL" || opp.risk_level === selectedRisk)
      ) {
        results.push(opp);
      }
    });
  });

  return results.sort((a, b) => b.net_apr - a.net_apr);
}

function renderTop() {
  const rows = filterOpportunities();
  if (!rows.length) {
    topOpportunityBody.innerHTML = `<tr><td colspan="5">No top opportunity</td></tr>`;
    return;
  }
  const top = rows[0];
  topOpportunityBody.innerHTML = `
    <tr>
      <td>${top.pair}</td>
      <td style="color: green; font-weight: bold;">+${top.net_apr.toFixed(2)}</td>
      <td>${top.long_dex}</td>
      <td>${top.short_dex}</td>
      <td>${top.risk_level}</td>
    </tr>
  `;
}

function renderTable() {
  const rows = filterOpportunities();
  if (!rows.length) {
    tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;">No opportunities found</td></tr>`;
    return;
  }

  tableBody.innerHTML = rows
    .map(
      (opp) => `
      <tr>
        <td>${opp.pair}</td>
        <td>${opp.long_dex}</td>
        <td>${opp.short_dex}</td>
        <td style="color: green; font-weight: bold">${opp.net_apr.toFixed(2)}</td>
        <td>${opp.risk_level}</td>
      </tr>
    `
    )
    .join("");
}

function renderAll() {
  renderTop();
  renderTable();
}

// Events
pairSelect.addEventListener("change", renderAll);
riskSelect.addEventListener("change", renderAll);
pairSearch.addEventListener("input", renderAll);
dexCheckboxes.forEach((cb) => cb.addEventListener("change", renderAll));

// Init
fetchData();
setInterval(fetchData, 30000);