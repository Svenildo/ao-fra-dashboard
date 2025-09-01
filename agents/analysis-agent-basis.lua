-- =========================================================
-- Pair Agent (e.g. BTC/ETH) - Funding Rate Arbitrage
-- DASHBOARD-ONLY VERSION (Aggregator removed)
-- v1.1 - Stable with Flush + optimized GC
-- =========================================================

local json = require("json")

-- –––– Configuration ––––
local DEFAULT_PAIR       = "BTC"   -- ⚠️ Change paire (BTC, ETH...), one paire per agent
local DEXS               = { "hyperliquid", "aevo", "backpack", "orderly", "dydx", "paradex", "extended" }
local PERIODS_PER_YEAR   = 3 * 365
local DEFAULT_FEES       = { maker = 0.0002, taker = 0.0005 }
local DASHBOARD_AGENT    = "Pf2l3pPnlUz_Ccz81BKvOljT_EoyAD191P4W-L-oL6Q"   -- ✅ Replace with actual ID
local FRESH_SEC          = 10 * 60
local GC_MAX_AGE_SEC     = 6 * FRESH_SEC
local MAX_VOLATILITY     = 0.002

-- –––– State ––––
State                 = State or {}
State.fundingData     = State.fundingData or {}
State.latest          = State.latest or {}
State.lastSent        = State.lastSent or {}
State.bestOpp         = State.bestOpp or {}

-- –––– Utils ––––
local function now() return os.time() end
local function toNum(x) return tonumber(x) or 0 end

local function logf(fmt, ...)
    local s = string.format(fmt, ...)
    print(s)
end

local function apr_from_period(rate)
    return (toNum(rate) or 0) * PERIODS_PER_YEAR * 100.0
end

-- –––– Garbage collector ––––
local function gcStale(pair)
    local t = now()
    for k, v in pairs(State.fundingData) do
        if (not pair) or (v.pair == pair) then
            local age = t - (toNum(v.timestamp) or 0)
            if age > GC_MAX_AGE_SEC then
                State.fundingData[k] = nil
            end
        end
    end
end

-- –––– Volatility & Risk ––––
local function calcVolatility(pair, dex)
    local values = {}
    for _, v in pairs(State.fundingData) do
        if v.pair == pair and v.dex == dex then
            values[#values+1] = toNum(v.funding_rate) or 0
        end
    end
    if #values < 2 then return 0 end

    local sum, sumSq = 0, 0
    for _, r in ipairs(values) do
        sum = sum + r
        sumSq = sumSq + r*r
    end
    local mean = sum / #values
    local variance = (sumSq / #values) - mean^2
    return math.sqrt(math.max(variance, 0))
end

local function classifyRisk(vol)
    if vol < 0.0005 then return "LOW"
    elseif vol < 0.002 then return "MEDIUM"
    else return "HIGH" end
end

-- –––– Compute opportunities ––––
local function computeAllOpportunities(pair)
    pair = pair or DEFAULT_PAIR
    local latest = State.latest[pair]
    if not latest then return {} end

    local opportunities = {}
    for long_dex, a in pairs(latest) do
        for short_dex, b in pairs(latest) do
            if long_dex ~= short_dex then
                local spread = a.rate_period - b.rate_period
                local one_off_fees = a.fees_taker + b.fees_taker
                local netAPR = (spread * PERIODS_PER_YEAR * 100.0) - (one_off_fees * 100.0)
            
            if netAPR > 0 then
                local vol_long = calcVolatility(pair, long_dex)
                local vol_short = calcVolatility(pair, short_dex)
                local avg_vol = (vol_long + vol_short) / 2
                local risk_level = classifyRisk(avg_vol)

                opportunities[#opportunities+1] = {
                    pair = pair,
                    long_dex = long_dex,
                    short_dex = short_dex,
                    spread = spread,
                    one_fees = one_off_fees,
                    net_apr = netAPR,
                    volatility = avg_vol,
                    risk_level = risk_level,
                    ts = now()
                }
                end
            end
        end
    end

    table.sort(opportunities, function(a, b)
        return a.net_apr > b.net_apr
    end)

    return opportunities
end

-- –––– Send to Dashboard ––––
local function sendToDashboard(pair, opportunities)
    ao.send({
        Target = DASHBOARD_AGENT,
        Action = "All-Opportunities",
        Pair = pair,
        Data = json.encode(opportunities)
    })
    logf("📊 Sent %d opportunities to Dashboard for %s", #opportunities, pair)
end

-- –––– Main processing ––––
local function processOpportunities(pair)
    local opportunities = computeAllOpportunities(pair)
    if #opportunities == 0 then
        logf("⚠️ No opportunities computed for %s", pair)
        return
    end

    -- Select best stable opportunity
    local best = nil
    for _, opp in ipairs(opportunities) do
        if opp.volatility <= MAX_VOLATILITY then
            best = opp
            break
        end
    end
    best = best or opportunities[1]
    State.bestOpp[pair] = best

    local hash = json.encode(best)
    if State.lastSent[pair] == hash then
        logf("🛑 No changes for %s, skipping broadcast", pair)
        return
    end

    sendToDashboard(pair, opportunities)
    State.lastSent[pair] = hash
end

-- –––– Funding-Update Handler ––––
Handlers.add(
    "Funding-Update",
    Handlers.utils.hasMatchingTag("Action", "Funding-Update"),
    function(msg)
        local pair = msg.Tags.Pair or DEFAULT_PAIR
        local source = msg.Tags.Source or "unknown"

        -- ✅ GC optimisé : un seul appel ici
        gcStale(pair)

        local rate = toNum(msg.Tags.Rate) or 0
        local timestamp = toNum(msg.Tags.Timestamp) or now()
        local data = {}

        if msg.Data and #msg.Data > 0 then
            local ok, decoded = pcall(json.decode, msg.Data)
            if ok and type(decoded) == "table" then
                data = decoded
            end
        end

        local key = string.format("%s_%s", source, pair)
        State.fundingData[key] = {
            dex = source,
            pair = pair,
            funding_rate = rate,
            liquidity = data.liquidity or {},
            fees = data.fees or DEFAULT_FEES,
            timestamp = timestamp
        }

        State.latest[pair] = State.latest[pair] or {}
        State.latest[pair][source] = {
            dex = source,
            pair = pair,
            rate_period = rate,
            fees_taker = toNum((data.fees or DEFAULT_FEES).taker),
            ts = timestamp
        }

        logf("📨 Funding update %s | rate=%.6f%% | APR≈%.4f%%", source, rate * 100, apr_from_period(rate))

        processOpportunities(pair)
    end
)

-- ✅ Commande Flush manuelle
Handlers.add(
    "Flush",
    Handlers.utils.hasMatchingTag("Action", "Flush"),
    function(msg)
        local pair = msg.Tags.Pair or DEFAULT_PAIR
        local opportunities = computeAllOpportunities(pair)
        sendToDashboard(pair, opportunities)
        logf("🔄 Manual flush sent %d opportunities to Dashboard for %s", #opportunities, pair)
    end
)

-- –––– Init ––––
logf("🚀 Pair Agent v1.1 (Dashboard-only) for %s initialized", DEFAULT_PAIR)
