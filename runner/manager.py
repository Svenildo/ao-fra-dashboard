# runner/manager.py
from time import time

stored_opportunities = {
    "last_updated": None,
    "table": {}  # format: { "BTC-USDT": [ ...opportunities... ] }
}

def handle_opportunity(data):
    table = stored_opportunities.get("table", {})

    for opp in data:
        pair = opp.get("pair")
        if not pair:
            continue

        entry = {
            "pair": pair,
            "short_dex": opp.get("short_dex"),
            "long_dex": opp.get("long_dex"),
            "net_apr": opp.get("net_apr"),
            "risk_level": opp.get("risk_level"),
            "timestamp": int(time())
        }

        if pair not in table:
            table[pair] = []

        # 🔁 Remplace si même combinaison short/long existe déjà
        replaced = False
        for i, existing in enumerate(table[pair]):
            if (existing["short_dex"] == entry["short_dex"] and
                existing["long_dex"] == entry["long_dex"]):
                table[pair][i] = entry
                replaced = True
                break

        if not replaced:
            table[pair].append(entry)

    stored_opportunities["last_updated"] = int(time())
    stored_opportunities["table"] = table

    return {"stored": True}

def get_latest_opportunities():
    return stored_opportunities

