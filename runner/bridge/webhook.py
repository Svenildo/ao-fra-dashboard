from flask import Flask, request, jsonify
from flask_cors import CORS  # ✅ Ajouté

import sys
import os

# Accès au dossier principal du projet
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from runner.manager import handle_opportunity, get_latest_opportunities

app = Flask(__name__)
CORS(app, ressources={r"/*":{"origins": ["https://your.site12345", "https://www.your.site12345"]}})  # ✅ Autorise uniquement ton domaine

# Logger simple pour TOUTES les requêtes
@app.before_request
def log_all_requests():
    app.logger.info(f"🔍 Reçu {request.method} sur {request.path}")

@app.route("/dashboard", methods=["GET"])
def health_check():
    return jsonify({"status": "ok"}), 200

@app.route("/dashboard", methods=["POST"])
def execute():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Invalid payload"}), 400

        app.logger.info(f"📩 Opportunité reçue : {data}")
        result = handle_opportunity(data)
        return jsonify({"status": "received", "result": result}), 200
    except Exception as e:
        app.logger.error(f"❌ Erreur dans /dashboard POST : {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/opportunities", methods=["GET"])
def get_opportunities():
    try:
        result = get_latest_opportunities()
        return jsonify({
            "status": "success",
            "result": result
        }), 200
    except Exception as e:
        app.logger.error(f"❌ Erreur dans /opportunities GET : {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.getenv("PORT", 3000))
    app.run(host="0.0.0.0", port=port)