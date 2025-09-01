-- =========================================================
-- Dashboard Agent - Funding Rate Arbitrage (Optimized)
-- Goal: Centralize opportunities + expose API to frontend
-- =========================================================

local json = require("json")

------------------------------------------------------------
-- STATE STRUCTURE
------------------------------------------------------------
State = State or {}
State.opportunities = State.opportunities or {}      -- Table: all opportunities by pair
State.topByPair = State.topByPair or {}              -- Best opp per pair
State.bestGlobal = State.bestGlobal or nil           -- Best opp overall
State.lastUpdated = State.lastUpdated or os.time()   -- For frontend polling freshness

------------------------------------------------------------
-- UTILS
------------------------------------------------------------
local function safeJsonDecode(data)
    if not data or #data == 0 then return {} end
    local ok, result = pcall(json.decode, data)
    return ok and result or {}
end

local function safeJsonEncode(data)
    local ok, result = pcall(json.encode, data)
    return ok and result or "{}"
end

local function now()
    return os.time()
end

------------------------------------------------------------
-- UPDATE BEST OPPORTUNITIES
------------------------------------------------------------
local function updateBestOpportunities()
    State.bestGlobal = nil

    for pair, oppList in pairs(State.opportunities) do
        -- Ensure sorted order for this pair (best APR first)
        table.sort(oppList, function(a, b)
            return (a.net_apr or 0) > (b.net_apr or 0)
        end)

        -- Store top opportunity per pair
        State.topByPair[pair] = oppList[1]

        -- Update global best
        if oppList[1] then
            if not State.bestGlobal or oppList[1].net_apr > State.bestGlobal.net_apr then
                State.bestGlobal = oppList[1]
            end
        end
    end
end

------------------------------------------------------------
-- HANDLER: RECEIVE ALL OPPORTUNITIES
------------------------------------------------------------
Handlers.add(
    "All-Opportunities",
    Handlers.utils.hasMatchingTag("Action", "All-Opportunities"),
    function(msg)
        local pair = msg.Tags.Pair
        if not pair then
            print("⚠️ Missing Pair tag in All-Opportunities message")
            return
        end

        local data = safeJsonDecode(msg.Data)

        -- Ignore if no data
        if type(data) ~= "table" or #data == 0 then
            print("⚠️ Empty opportunities for pair " .. pair)
            return
        end

        -- Store all opportunities for this pair
        State.opportunities[pair] = data

        -- Update best per pair + global best
        updateBestOpportunities()

        -- Update timestamp for frontend polling
        State.lastUpdated = now()

        print("📩 Stored " .. #data .. " opportunities for " .. pair)
    end
)

------------------------------------------------------------
-- HANDLER: EXPOSE API TO BACKEND (CORRECTED)
------------------------------------------------------------
Handlers.add(
    "Get-All-Opportunities",
    Handlers.utils.hasMatchingTag("Action", "Get-All-Opportunities"),
    function(msg)
        local response = {
            last_updated = State.lastUpdated,
            top_opportunities = State.topByPair,
            best_global = State.bestGlobal,
            table = State.opportunities
        }

        -- ✅ Use ao.reply instead of ao.send
        ao.reply(msg, {
            Data = safeJsonEncode(response)
        })

        print("📤 Replied with opportunities snapshot to backend")
    end
)
