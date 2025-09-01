const axios = require('axios');

const GRAPHQL_URL = 'https://arweave-search.goldsky.com/graphql';
const TARGET_PROCESS_ID = 'Pf2l3pPnlUz_Ccz81BKvOljT_EoyAD191P4W-L-oL6Q'; // <-- Change with your PID
const TARGET_PROTOCOL = 'ao';
const POLL_INTERVAL = 5000; // en ms
const ENDPOINT_URL = 'https://your.endpoint12345';

let lastMessageTxId = null;

async function getLastMessageTransaction() {
  const query = {
    query: `
      query {
        transactions(
          tags: [
            { name: "Data-Protocol", values: ["${TARGET_PROTOCOL}"] },
            { name: "Process", values: ["${TARGET_PROCESS_ID}"] }
          ],
          sort: HEIGHT_DESC,
          first: 1
        ) {
          edges {
            node {
              id
              tags {
                name
                value
              }
            }
          }
        }
      }
    `
  };

  try {
    const res = await axios.post(GRAPHQL_URL, query);
    const node = res.data?.data?.transactions?.edges?.[0]?.node;

    return node || null;
  } catch (err) {
    console.error('❌ Erreur GraphQL :', err.message);
    return null;
  }
}

async function fetchTransactionData(arweaveId) {
  try {
    const res = await axios.get(`https://arweave.net/raw/${arweaveId}`);

    if (typeof res.data === 'string') {
      try {
        return JSON.parse(res.data);
      } catch (e) {
        console.warn(`⚠️ Donnée brute non-JSON pour ${arweaveId} :`, res.data);
        return null;
      }
    }

    return res.data;
  } catch (err) {
    console.error(`❌ Erreur de récupération Arweave (${arweaveId}) :`, err.response?.status || err.message);
    return null;
  }
}

async function sendToEndpoint(data) {
  try {
    const res = await axios.post(ENDPOINT_URL, data);
    console.log('✅ Données envoyées à l’API. Statut :', res.status);
  } catch (err) {
    console.error('❌ Erreur d’envoi à l’API :', err.message);
  }
}

async function poll() {
  console.log('🔍 Vérification des nouveaux messages...');

  const tx = await getLastMessageTransaction();
  if (!tx) {
    console.warn('⛔ Aucune transaction trouvée.');
    return;
  }

  if (tx.id === lastMessageTxId) {
    console.log('⏳ Aucun nouveau message.');
    return;
  }

  console.log(`📩 Nouveau message détecté : ${tx.id}`);
  lastMessageTxId = tx.id;

  const messageTag = tx.tags.find(t => t.name === 'Message');
  if (!messageTag || !messageTag.value) {
    console.warn(`⚠️ Pas de tag 'Message' dans la transaction ${tx.id}`);
    return;
  }

  const arweaveId = messageTag.value;
  const data = await fetchTransactionData(arweaveId);

  if (!data) {
    console.warn(`⚠️ Message ${arweaveId} sans contenu utilisable.`);
    return;
  }

  await sendToEndpoint(data);
}

console.log('🚀 Surveillance des messages AO démarrée...');
setInterval(poll, POLL_INTERVAL);
