// ============================================================
// Vibe Check — API Service
// Handles predictions via Groq Llama 3.2 Vision
// ============================================================

// ── Request Queue with Rate Limiting ─────────────────────────
// Prevents API quota exhaustion by capping RPM,
// handling 429 backoff, and dropping overflow requests.
class RequestQueue {
  constructor({ maxPerMinute = 28, maxQueueSize = 50 } = {}) {
    this.maxPerMinute = maxPerMinute;
    this.maxQueueSize = maxQueueSize;
    this.timestamps = [];       // Tracks request timestamps for RPM window
    this.queue = [];             // Pending { payload, resolve } entries
    this.processing = false;     // Is the drain loop active?
    this.backoffUntil = 0;       // Timestamp when backoff ends
  }

  /**
   * Enqueue a request. Returns a Promise that resolves with the
   * API result when the request is eventually processed.
   */
  enqueue(payload, executeFn) {
    // Queue cap — drop silently if overloaded
    if (this.queue.length >= this.maxQueueSize) {
      console.warn('[Vibe Check] Queue full (' + this.maxQueueSize + ') — dropping request, returning safe.');
      return Promise.resolve({ vibe: 'safe', reasoning: 'Queue full — request dropped to prevent overload.' });
    }

    return new Promise((resolve) => {
      this.queue.push({ payload, executeFn, resolve });
      this._drain();
    });
  }

  /**
   * Process queued requests one at a time, respecting the RPM
   * cap and any active 429 backoff.
   */
  async _drain() {
    if (this.processing) return; // Only one drain loop at a time
    this.processing = true;

    while (this.queue.length > 0) {
      // ── 429 Backoff ─────────────────────────────────────
      const now = Date.now();
      if (now < this.backoffUntil) {
        const waitMs = this.backoffUntil - now;
        console.log('[Vibe Check] Queue paused for 429 backoff:', Math.ceil(waitMs / 1000) + 's');
        await this._sleep(waitMs);
      }

      // ── RPM Window ──────────────────────────────────────
      // Prune timestamps older than 60s
      const cutoff = Date.now() - 60000;
      this.timestamps = this.timestamps.filter(t => t > cutoff);

      if (this.timestamps.length >= this.maxPerMinute) {
        // Wait until the oldest timestamp exits the window
        const waitMs = this.timestamps[0] - cutoff + 50; // +50ms buffer
        console.log('[Vibe Check] RPM cap hit (' + this.maxPerMinute + '/min) — waiting', Math.ceil(waitMs / 1000) + 's');
        await this._sleep(waitMs);
        continue; // Re-check after waiting
      }

      // ── Execute ─────────────────────────────────────────
      const { payload, executeFn, resolve } = this.queue.shift();
      this.timestamps.push(Date.now());

      try {
        const result = await executeFn(payload);
        resolve(result);
      } catch (err) {
        // If executeFn signaled a 429, apply backoff and re-queue
        if (err._vibeCheck429) {
          this.backoffUntil = Date.now() + (err._backoffMs || 60000);
          console.warn('[Vibe Check] 429 received — backing off for', Math.ceil((err._backoffMs || 60000) / 1000) + 's');
          // Put the request back at the front of the queue
          this.queue.unshift({ payload, executeFn, resolve });
          continue;
        }
        // Other errors — resolve as 'safe' (not a content signal)
        console.error('[Vibe Check] Queue execution error:', err);
        resolve({ vibe: 'safe', reasoning: 'Internal processing error.' });
      }
    }

    this.processing = false;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export class VibePredictionService {
  constructor() {
    this.groqApiKey = ENTER - API - KEY - HERE;

    // Rate-limited queue: 28 requests per 60s, max 50 queued
    this.queue = new RequestQueue({ maxPerMinute: 28, maxQueueSize: 50 });
  }

  /**
   * Main entry point for predictions.
   * Swap the internal call to switch AI backends without
   * touching any content script code.
   */
  async predict(payload) {
    const USE_TRIBE_V2 = false; // Toggle flag for TRIBE v2 stub

    if (USE_TRIBE_V2) {
      return this.queue.enqueue(payload, (p) => this.fetchFromTribeV2(p));
    }

    return this.queue.enqueue(payload, (p) => this.fetchFromGroq(p));
  }

  // ── Groq Llama 3.2 11b Vision ───────────────────────────
  async fetchFromGroq({ text, image }) {
    if (!this.groqApiKey) {
      console.warn('[Vibe Check] No Groq API key configured — defaulting to safe.');
      return { vibe: 'safe', reasoning: 'No API key configured.' };
    }

    const safeText = text || '(no text — analyze image only)';
    const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

    // Three-tier context-aware prompt with concrete examples.
    const prompt =
      'You are a content moderator for a neurodivergent accessibility tool.\n' +
      'Classify posts into exactly one of three tiers. Read the full post before deciding.\n\n' +
      'INTENSE — blur this content:\n' +
      '- Graphic gore, open wounds, blood, bodily damage shown visually or described in detail\n' +
      '- Graphic violence, death, or injury described in a disturbing way\n' +
      '- Sexual assault, abuse, grooming, predatory behavior\n' +
      '- Explicit sexual or pornographic content (e.g. "goon edits", onlyfans ads, explicit descriptions)\n' +
      '- Detailed first-person trauma accounts involving assault or abuse\n\n' +
      'WARNING — show amber dot, no blur:\n' +
      '- Heated arguments, relationship drama, breakups, divorce, cheating\n' +
      '- Mental health struggles: depression, anxiety, suicidal ideation (without graphic detail)\n' +
      '- Addiction, relapse, sobriety struggles\n' +
      '- Death or grief mentioned without graphic description ("my dog died", "I lost my mom")\n' +
      '- Significant anger, venting, or distress that would be emotionally draining\n' +
      '- Medical topics that are uncomfortable but not visually graphic (e.g. discussing a diagnosis)\n' +
      '- Strong swearing in an emotional context (not casual)\n' +
      '- Content warnings or trigger warnings in the post title even if body is mild\n\n' +
      'SAFE — green dot:\n' +
      '- Everyday content, memes, humor, gaming, hobbies, sports\n' +
      '- Supportive or recovery-focused posts even if topic is sensitive ("one year sober 🎉")\n' +
      '- Educational, clinical, or news content about difficult topics without graphic detail\n' +
      '- Mild frustration or casual swearing ("ugh my code won\'t compile, fuck")\n' +
      '- Wholesome, neutral, or positive content\n\n' +
      'Key principle: WARNING is the default for anything emotionally heavy but not graphic. ' +
      'When in doubt between safe and warning, choose warning. ' +
      'When in doubt between warning and intense, choose intense.\n\n' +
      'You MUST respond with ONLY a valid JSON object in this exact format:\n' +
      '{"vibe": "safe", "reasoning": "One short sentence explaining why."}\n\n' +
      'The "vibe" field must be exactly one of: intense, warning, safe.\n' +
      'The "reasoning" field must be one short sentence (under 20 words).\n' +
      'Do not include any text outside the JSON object. Do not use markdown code fences.\n\n' +
      'Text:\n' + safeText;

    const contentArray = [{ type: "text", text: prompt }];

    if (image && image.data && image.mimeType) {
      contentArray.push({
        type: "image_url",
        image_url: {
          url: "data:" + image.mimeType + ";base64," + image.data
        }
      });
      console.log('[Vibe Check] Sending to Groq — multimodal (text + image):', image.mimeType);
    } else {
      console.log('[Vibe Check] Sending to Groq — text only, length:', safeText.length);
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.groqApiKey}`
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{ role: 'user', content: contentArray }],
          response_format: { type: "json_object" },
          temperature: 0.0,
          max_tokens: 150
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[Vibe Check] Groq HTTP Error:', response.status, errorBody);

        if (response.status === 429) {
          const err = new Error('429 Too Many Requests');
          err._vibeCheck429 = true;
          err._backoffMs = 60000;
          throw err;
        }

        return { vibe: 'safe', reasoning: 'API error.' };
      }

      const data = await response.json();
      console.log('[Vibe Check] Groq raw response:', JSON.stringify(data).substring(0, 500));

      const textResponse = data.choices?.[0]?.message?.content || '';
      console.log('[Vibe Check] Groq raw text:', textResponse);

      let parsed = null;
      try {
        const jsonStr = textResponse
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        parsed = JSON.parse(jsonStr);
      } catch (_) {
        console.warn('[Vibe Check] JSON parse failed, falling back to keyword match.');
      }

      if (parsed && parsed.vibe) {
        const vibe = parsed.vibe.toLowerCase().trim();
        const reasoning = parsed.reasoning || 'No explanation provided.';
        if (['intense', 'warning', 'safe'].includes(vibe)) {
          return { vibe, reasoning };
        }
      }

      const cleanResponse = textResponse.toLowerCase().replace(/[^a-z]/g, '');
      if (cleanResponse.includes('intense')) return { vibe: 'intense', reasoning: 'Classified by AI.' };
      if (cleanResponse.includes('warning')) return { vibe: 'warning', reasoning: 'Classified by AI.' };
      if (cleanResponse.includes('safe')) return { vibe: 'safe', reasoning: 'Classified by AI.' };

      return { vibe: 'safe', reasoning: 'Could not parse AI response.' };

    } catch (error) {
      if (error._vibeCheck429) throw error;
      console.error('[Vibe Check] Groq API Error:', error);
      return { vibe: 'safe', reasoning: 'Network or connection error.' };
    }
  }

  // ── TRIBE v2 (Future) ───────────────────────────────────
  async fetchFromTribeV2(multimodalData) {
    // TODO: Meta TRIBE v2 — accepts multi-modal inputs
    // (text, video frames, audio spectrograms) and returns
    // 3D fMRI voxel activation maps for emotional prediction.
    console.log('[Vibe Check] fetchFromTribeV2 called with data:', multimodalData);
    throw new Error('fetchFromTribeV2 not yet implemented');
  }
}
