// ============================================================
// Vibe Check — Background Service Worker
// ============================================================

import { VibePredictionService } from './api_service.js';

const predictionService = new VibePredictionService();

// ── Message Listener ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyzeText') {
    predictionService
      .predict({ text: request.text, image: request.image })
      .then((result) => {
        // result is { vibe, reasoning } from api_service
        sendResponse({ vibe: result.vibe, reasoning: result.reasoning });
      })
      .catch((error) => {
        // Pipeline crash — not a content signal, default safe.
        console.error('[Vibe Check] Prediction pipeline error:', error);
        sendResponse({ vibe: 'safe', reasoning: 'Internal processing error.', error: error.toString() });
      });

    // Return true — we respond asynchronously
    return true;
  }
});
