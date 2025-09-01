AO Listener – Monitor AO Messages from Arweave
=============================================

This project monitors AO messages from Arweave using Goldsky's GraphQL endpoint,
retrieves associated payloads, and forwards them to a local Flask API.
The API stores and exposes detected trading opportunities.

Project Structure
-----------------

runner/
├── ao-api.cjs             # Node.js script that watches Arweave (AO)
├── manager.py             # Handles storage of opportunities
└── bridge/
    └── webhook.py         # Flask API to receive and serve data

Setup Instructions
------------------

1. Install Python Dependencies:

   pip install Flask==2.3.3 flask-cors==4.0.0

2. Install Node.js Dependencies:

   npm install axios@1.6.0

3. Install PM2 Globally (if not already):

   npm install -g pm2

Running the System with PM2
---------------------------

1. Start the Flask API (webhook.py):

   pm2 start runner/bridge/webhook.py --interpreter python3 --name ao-api-server

   Flask will run on port 3000 by default. It exposes:
     - GET /dashboard         Health check
     - POST /dashboard        Receives opportunities
     - GET /opportunities     Returns stored opportunities

2. Start the AO Listener (ao-api.cjs):

   Make sure to update ENDPOINT_URL in ao-api.cjs to:
     const ENDPOINT_URL = 'http://localhost:3000/dashboard';

   Then run:
     pm2 start runner/ao-api.cjs --name ao-listener

Testing the System
------------------

To view stored opportunities:

   curl http://localhost:3000/opportunities

Configuration
-------------

In ao-api.cjs, configure the following:

   const TARGET_PROCESS_ID = 'your agent PID';
   const POLL_INTERVAL = 5000; // in milliseconds

Dependencies Summary
--------------------

Python:

   pip install Flask==2.3.3 flask-cors==4.0.0

Node.js:

   npm install axios@1.6.0

Global:

   npm install -g pm2

PM2 Commands
------------

| Task                    | Command                                 |
|-------------------------|-----------------------------------------|
| List all processes      | pm2 ls                                  |
| Restart a process       | pm2 restart ao-listener                 |
| Stop a process          | pm2 stop ao-api-server                  |
| View logs               | pm2 logs                                |
| Save startup config     | pm2 save                                |
| Startup on boot         | pm2 startup (follow PM2 instructions)   |

Suggestions for Improvement
---------------------------

- Add API key verification to secure the /dashboard endpoint
- Store opportunities in a persistent database
- Export data as CSV or JSON
- Build a frontend dashboard