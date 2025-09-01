Afra Funding Rate Arbitrage Dashboard – Front-End
=================================================

This front-end provides a dashboard to visualize arbitrage opportunities
between different DEXs based on funding rate data collected on-chain.

The dashboard displays:
- The top opportunity with the best net APR
- A searchable, filterable table of all current opportunities
- Filtering by pair, DEX, and risk level
- Dark/light mode toggle (theme saved in localStorage)

Files
-----

front-end/
├── index.html       # Main HTML page with layout and containers
├── script.js        # Client-side logic (data fetching, filtering, rendering)
└── style.css        # Theme styling, responsive design, and light/dark support

Hosting Instructions
--------------------

This dashboard is 100% static and can be hosted on:
- GitHub Pages
- Vercel / Netlify
- Any static file server (Nginx, Apache, etc.)

Simply serve the folder `front-end/` as a static website.

Dependencies
------------

No external JavaScript dependencies are required.
The app uses:
- `fetch()` for API requests
- Vanilla JavaScript and CSS
- LocalStorage for theme persistence

API Endpoint
------------

The dashboard expects the following API endpoint:

  https://api.afra.finance/opportunities

This should return a JSON object like:

{
  "status": "success",
  "result": {
    "last_updated": 1693528382,
    "top_opportunities": { ... },
    "best_global": { ... },
    "table": {
      "BTC": [ ...opportunities... ],
      "ETH": [ ...opportunities... ],
      ...
    }
  }
}

Customization
-------------

To use your own API backend, update this line in `script.js`:

    const res = await fetch("https://api.your.site");

You can replace the URL with your own endpoint (e.g., localhost or hosted API).

Features
--------

- Fully responsive layout
- Minimalistic design with CSS variables
- Dark/light theme toggle (🌓 button)
- Search, filter by pair, risk level, and DEX
- Updates data every 30 seconds
