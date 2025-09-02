# 🧠 Funding Rate Arbitrage AO Agents

A modular, decentralized system of AO-based autonomous agents that monitors funding rates across perpetual DEXs (like dYdX, Hyperliquid, Backpack...), identifies arbitrage opportunities, and presents them via a live dashboard.

---

## 📌 Overview

This project builds an end-to-end decentralized arbitrage monitoring system using the AO protocol on Arweave. It includes:

- 📡 **Collector agents** (per DEX) that gather funding rate data and send messages to AO.
- 🧠 **Pair agents** (per asset) that analyze funding data and compute arbitrage opportunities.
- 🧠 **Dashboard agent** that aggregates opportunities and exposes an API via AO messaging.
- 🚀 **Polling script** that monitors AO for updates and forwards them to the backend.
- 🌐 **Backend Flask API** that receives opportunities and exposes endpoints.
- 🖼️ **Frontend Dashboard** (vanilla HTML/CSS/JS) for live visualization.

---

## 🧩 Architecture

```plaintext
                  Collector Agents (Node.js)
              [ per DEX: dYdX, Backpack, Paradex... ]
                                │
                                ▼
         +------------------ AO Protocol -------------------+
         |     Pair Agents (Lua)  |     Dashboard Agent     |
         | [ETH, BTC, etc.]      |  Aggregates all data     |
         +--------------------------------------------------+
                                │
                                ▼
                    Polling Script (ao-api.cjs)
                                │
                                ▼
                         Flask API Webhook (Python)
                                │
                                ▼
                         Frontend (HTML/JS/CSS)
```

---

## 🛠️ Components

### 📡 Collectors (Node.js)

- Located in `collectors/`
- One file per exchange (e.g. `run-dydx.js`)
- Uses PM2 for scheduling and retries
- Sends `Funding-Update` messages to AO

Start with:

```bash
npm install
pm2 start ecosystem.config.cjs
```

Environment required:

- `WALLET_PATH`, `ALLOWED_PAIRS`, `ANALYSIS_<PAIR>_PROCESS`, etc.

---

### 🧠 Pair Agents (Lua on AO)

- Located in `agents/`
- One per asset (e.g., `analysis-agent-btc.lua`)
- Listens for `Funding-Update`
- Computes long/short spreads, volatility, and net APR
- Sends `All-Opportunities` to the dashboard agent

---

### 📊 Dashboard Agent (Lua on AO)

- Receives opportunities from all pair agents
- Aggregates best opportunities per pair and globally
- Responds to `Get-All-Opportunities` requests with all data

---

### 🚀 AO Polling Script (Node.js)

- File: `runner/ao-api.cjs`
- Polls AO for new messages using GraphQL (via Goldsky)
- Retrieves the content of `Message` tag transactions
- Sends JSON data to Flask API

Start with:

```bash
node runner/ao-api.cjs
# Or with pm2:
pm2 start runner/ao-api.cjs --name ao-listener
```

---

### 🌐 Flask API (Python)

- File: `runner/bridge/webhook.py`
- Receives data from AO poller
- Stores it in memory via `manager.py`
- Exposes endpoints:

  - `GET /dashboard` — health check
  - `POST /dashboard` — receive opportunities
  - `GET /opportunities` — return stored data

Start with:

```bash
pip install Flask flask-cors
python runner/bridge/webhook.py
```

Or with PM2:

```bash
pm2 start runner/bridge/webhook.py --interpreter python3 --name ao-api-server
```

---

### 🖼️ Frontend (HTML)

- Located in `front-end/`
- Static SPA dashboard (no framework)
- Fetches from Flask API endpoint (or your own)
- Supports filters, search, top APR

No build needed. Just serve the folder with any static server:

```bash
cd front-end
python -m http.server 8080
# Or deploy to Netlify, Vercel, GitHub Pages...
```

---

## ⚙️ Environment Overview

Here are key environment variables used across components:

```env
# Collectors
WALLET_PATH=../wallet.json
ALLOWED_PAIRS=BTC,ETH,SOL
ANALYSIS_BTC_PROCESS=...
ANALYSIS_ETH_PROCESS=...

# Collector tuning
COLLECT_INTERVAL_MS=300000
JITTER_MS=5000
SKIP_UNCHANGED=1
DRY_RUN=0

# API
PORT=3000

# Dashboard agent
DASHBOARD_AGENT=...
```

---

## 🔁 Data Flow Summary

```plaintext
DEX (dYdX...) →
    Collector →
        AO (Funding-Update) →
            Pair Agent →
                AO (All-Opportunities) →
                    Dashboard Agent →
                        Polling Script →
                            Flask API →
                                Front-End
```

---

## 📦 Tech Stack

- **Node.js** — Data collection & AO message senders
- **Lua on AO** — Autonomous agent logic
- **Flask (Python)** — API backend
- **HTML/CSS/JS** — Dashboard UI
- **PM2** — Process management and scheduling
- **Arweave / AO Protocol** — Decentralized agent execution & messaging

---