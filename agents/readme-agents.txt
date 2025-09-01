AO Agents – Funding Rate Arbitrage (Lua)
========================================

This AO agent system implements funding rate arbitrage logic using Lua smart agents
running on the AO protocol. Each pair (e.g., BTC, ETH) has its own agent that monitors
funding data and identifies arbitrage opportunities between DEXes.

There is also a central dashboard agent that receives all computed opportunities and
exposes them to external systems (e.g., frontends or APIs).

Agent Files
-----------

agents/
├── analysis-agent-btc.lua        # Agent for a single pair (e.g., BTC)
├── analysis-agent-eth.lua        # (same logic, just different pair)
├── dashboard-agent.lua           # Central aggregator & API responder

Pair Agent Logic
----------------

Each pair agent:

1. Receives messages with Action = "Funding-Update"
2. Stores funding data per DEX (e.g., dYdX, Paradex, etc.)
3. Computes all possible long/short combinations and their net APR
4. Estimates volatility and classifies risk (LOW, MEDIUM, HIGH)
5. Selects best stable opportunity (low volatility), and sends to dashboard agent
6. Avoids re-sending if opportunity hasn't changed
7. Responds to Action = "Flush" to force recomputation and resend

Configurable Constants:

- DEFAULT_PAIR: Must be set per file (e.g., "BTC")
- DASHBOARD_AGENT: AO process ID for the dashboard agent (replace manually)
- DEXS: List of exchanges to compare

Dashboard Agent Logic
---------------------

The dashboard agent:

1. Receives "All-Opportunities" messages from pair agents
2. Stores all opportunities by pair
3. Computes the best opportunity per pair and globally
4. Exposes an API using Action = "Get-All-Opportunities" which replies with:
   - last_updated: Timestamp
   - top_opportunities: Best per pair
   - best_global: Best across all pairs
   - table: All current opportunities

Testing in AO
-------------

To test agents in AO:

1. Deploy each analysis-agent with its own `DEFAULT_PAIR` and correct `DASHBOARD_AGENT`
2. Deploy the dashboard-agent once and record its process ID
3. Make sure funding collectors send messages with:
   - Action = "Funding-Update"
   - Tags: Pair, Source, Rate, Timestamp
   - Data: JSON with funding_rate, next_funding, liquidity, fees

4. Trigger flush manually by sending:
   - Action = "Flush"
   - Tag: Pair = "BTC" (or other)

Data Flow
---------

[dydx/hyperliquid/etc.]
       ↓  Funding-Update (with rate & meta)
[ analysis-agent-BTC.lua ]
       ↓  All-Opportunities (JSON)
[ dashboard-agent.lua ]
       ↔  Get-All-Opportunities
       ↑  (e.g. by backend API or frontend)
