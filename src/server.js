import express from 'express';
import { runAgent } from './agent.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'EMS Activation Agent (Gemini) online', timestamp: new Date().toISOString() });
});

// EMS Webhook receiver
app.post('/webhook/ems', async (req, res) => {
  console.log('[webhook] Received:', JSON.stringify(req.body, null, 2));

  // Acknowledge immediately — EMS expects fast 200
  res.status(200).json({ received: true });

  // Run agent async
  try {
    await runAgent(req.body);
  } catch (err) {
    console.error('[agent] Error:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
