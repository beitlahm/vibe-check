// ============================================================
// Vibe Check — Content Script
// Deep-scrapes post text and images (including Shadow DOM),
// sends them to the background service worker for Gemini
// classification, and injects traffic-light UI + blur overlays.
//
// SAFETY PHILOSOPHY: Only confirmed API safety blocks → 'intense'.
// Messaging errors and network issues → 'safe' (not content signals).
// ============================================================

// Cache of processed post elements — prevents duplicate API calls
const processedPosts = new Set();

// Selectors that match "post" containers across major platforms.
// shreddit-post is Reddit's modern custom element.
const POST_SELECTOR = [
  'shreddit-post',                         // Modern Reddit (new new Reddit)
  'div[data-testid="post-container"]',     // Reddit redesign fallback
  'div[data-testid="search-post-unit"]',   // Reddit search results
  'search-telemetry-tracker shreddit-post',// Reddit search wrapper
  'article',                               // Generic / Twitter / Bluesky
  'div[data-testid="tweet"]',              // Twitter/X legacy
  'div.post',                              // Old Reddit CSS
  '.thing',                                // Old Reddit (RES compatible)
].join(', ');

// ── Look-Ahead IntersectionObserver ──────────────────────────
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;

    const post = entry.target;
    if (processedPosts.has(post)) continue;
    processedPosts.add(post);

    // Stop observing — we only need the first intersection
    observer.unobserve(post);

    analyzePost(post);
  }
}, {
  root: null,
  rootMargin: '0px 0px 1500px 0px', // Scan 1500px ahead of viewport
  threshold: 0.0
});

// ── Deep Text Extraction ─────────────────────────────────────
// Reddit's <shreddit-post> hides real content inside a Shadow
// DOM tree. Standard innerText on the host element returns the
// post title at best, never the body. We need to pierce every
// layer aggressively.

/**
 * Recursively collect text from a root, piercing shadow roots
 * and named slots along the way.
 */
const deepExtractText = (root) => {
  const fragments = [];

  // 1. Shreddit-specific: check common attribute-based title FIRST
  //    (this is the most reliable source on modern Reddit)
  const attrTitle = root.getAttribute?.('post-title');
  if (attrTitle) fragments.push(attrTitle);

  // 2. Direct light-DOM text
  const lightText = (root.innerText || root.textContent || '').trim();
  if (lightText) fragments.push(lightText);

  // 3. Pierce shadow root if present
  if (root.shadowRoot) {
    // Look for slotted content and paragraphs inside shadow DOM
    const shadowTargets = root.shadowRoot.querySelectorAll(
      '[slot="text-body"], [slot="title"], p, h1, h2, h3, span'
    );
    shadowTargets.forEach(el => {
      const t = (el.innerText || el.textContent || '').trim();
      if (t) fragments.push(t);
    });

    // Fallback: grab everything from the shadow root
    if (shadowTargets.length === 0) {
      const fallback = (root.shadowRoot.innerText || root.shadowRoot.textContent || '').trim();
      if (fallback) fragments.push(fallback);
    }
  }

  // 4. Light-DOM deep search for slot and paragraph elements
  //    (covers cases where Reddit projects content into light DOM)
  const lightTargets = root.querySelectorAll(
    '[slot="text-body"], [slot="title"], div[id*="post-rtjson"], p'
  );
  lightTargets.forEach(el => {
    const t = (el.innerText || el.textContent || '').trim();
    if (t) fragments.push(t);
  });

  // Deduplicate fragments (same text often appears in multiple selectors)
  const seen = new Set();
  const unique = fragments.filter(f => {
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });

  return unique.join(' ');
};

// ── Deep Image Extraction ────────────────────────────────────
// Aggressively search for images, specifically targeting Reddit
// CDN URLs: preview.redd.it, i.redd.it, external-preview.redd.it
const deepExtractImage = (root) => {
  const IMG_SELECTORS = [
    'img[src*="preview.redd.it"]',
    'img[src*="i.redd.it"]',
    'img[src*="external-preview.redd.it"]',
    'img.media-image',
    'img[alt]',  // Most real content images have alt text
  ].join(', ');

  // Try shadow root first for shreddit-post
  if (root.shadowRoot) {
    const shadowImg = root.shadowRoot.querySelector(IMG_SELECTORS);
    if (shadowImg && shadowImg.src && !isIcon(shadowImg)) return shadowImg.src;
  }

  // Then light DOM
  const lightImg = root.querySelector(IMG_SELECTORS);
  if (lightImg && lightImg.src && !isIcon(lightImg)) return lightImg.src;

  return null;
};

// Filter out tiny icons, avatars, and UI chrome
const isIcon = (img) => {
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  // Skip anything smaller than 64x64 (likely an icon/avatar)
  if (w > 0 && w < 64) return true;
  if (h > 0 && h < 64) return true;
  // Skip avatar images
  if (img.src && img.src.includes('avatar')) return true;
  return false;
};

// ── Fetch Image as Base64 ────────────────────────────────────
// Uses a canvas to convert the image, avoiding CORS issues with
// cross-origin fetch. Caps dimensions at 512px to save tokens.
const fetchImageAsBase64 = async (url) => {
  try {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // Request CORS access

      const timeout = setTimeout(() => {
        console.warn('[Vibe Check] Image fetch timed out:', url);
        resolve(null);
      }, 5000); // 5 second timeout

      img.onload = () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          // Cap image dimensions to 512px max
          const maxDim = 512;
          let w = img.naturalWidth;
          let h = img.naturalHeight;
          if (w > maxDim || h > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          resolve({
            mimeType: 'image/jpeg',
            data: dataUrl.split(',')[1] // Strip data URI prefix
          });
        } catch (canvasErr) {
          // Tainted canvas (CORS blocked drawing)
          console.warn('[Vibe Check] Canvas tainted, falling back to fetch:', canvasErr.message);
          fetchImageViaFetch(url).then(resolve);
        }
      };

      img.onerror = () => {
        clearTimeout(timeout);
        console.warn('[Vibe Check] Image load failed, trying fetch fallback:', url);
        fetchImageViaFetch(url).then(resolve);
      };

      img.src = url;
    });
  } catch (err) {
    console.error('[Vibe Check] Error in fetchImageAsBase64:', err);
    return null;
  }
};

// Fallback: direct fetch with CORS mode
const fetchImageViaFetch = async (url) => {
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return null;
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve({
          mimeType: blob.type || 'image/jpeg',
          data: reader.result.split(',')[1]
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.warn('[Vibe Check] Fetch fallback also failed:', err.message);
    return null;
  }
};

// ── Analyze a Post ───────────────────────────────────────────
// Track which posts have had UI applied to prevent double-blur races
const uiAppliedPosts = new Set();

const analyzePost = async (post) => {
  if (post.hasAttribute('data-vibe-processed')) return;
  post.setAttribute('data-vibe-processed', 'true');

  // Stop double processing on Reddit: pierce Shadow DOM to detect nested posts
  let curr = post.parentNode;
  let isNested = false;
  while (curr) {
    // If it's a shadow root, step up to the host element
    if (curr instanceof ShadowRoot) {
      curr = curr.host;
    }
    // If the element matches POST_SELECTOR, abort
    if (curr && curr.matches && curr.matches(POST_SELECTOR)) {
      isNested = true;
      break;
    }
    curr = curr.parentNode;
  }
  if (isNested) return;

  const text = deepExtractText(post);
  const imageUrl = deepExtractImage(post);

  // Skip trivially short content AND no images — nothing to analyze
  if ((!text || text.length < 15) && !imageUrl) {
    console.warn('[Vibe Check] Skipped — insufficient text/image for post:', post);
    return;
  }

  if (text) console.log('[Vibe Check] Extracted Text:', text.substring(0, 120) + '…');
  if (imageUrl) console.log('[Vibe Check] Extracted Image URL:', imageUrl);

  // ── Optimistic Loading State ─────────────────────────────
  post.classList.add('vibe-blurred');
  const loadingOverlay = document.createElement('div');
  loadingOverlay.classList.add('vibe-blur-overlay');

  const loadingCard = document.createElement('div');
  loadingCard.classList.add('vibe-blur-card');

  const spinner = document.createElement('div');
  spinner.classList.add('vibe-spinner');

  const loadingText = document.createElement('p');
  loadingText.classList.add('vibe-blur-reasoning');
  loadingText.textContent = 'Checking vibe...';

  loadingCard.appendChild(spinner);
  loadingCard.appendChild(loadingText);
  loadingOverlay.appendChild(loadingCard);
  post.appendChild(loadingOverlay);

  // Convert image to Base64 if present
  let imageData = null;
  if (imageUrl) {
    imageData = await fetchImageAsBase64(imageUrl);
    if (imageData) {
      console.log('[Vibe Check] Image converted to Base64 successfully.');
    } else {
      console.warn('[Vibe Check] Image conversion failed — sending text only.');
    }
  }

  // Send to background service worker for classification
  try {
    chrome.runtime.sendMessage(
      {
        action: 'analyzeText',
        text: text ? text.substring(0, 3000) : '',
        image: imageData
      },
      (response) => {
        // Remove optimistic loading state
        loadingOverlay.remove();
        post.classList.remove('vibe-blurred');

        // Abort if UI was already applied (race condition guard)
        if (uiAppliedPosts.has(post)) return;

        if (chrome.runtime.lastError) {
          console.error('[Vibe Check] Messaging error:', chrome.runtime.lastError.message);
          applyVibeUI(post, 'safe', 'Background script disconnected.');
          return;
        }

        const vibe = response?.vibe || 'safe';
        const reasoning = response?.reasoning || 'No explanation available.';
        console.log('[Vibe Check] Vibe result:', vibe, '| Reasoning:', reasoning);
        applyVibeUI(post, vibe, reasoning);
      }
    );
  } catch (err) {
    loadingOverlay.remove();
    post.classList.remove('vibe-blurred');
    console.error('[Vibe Check] sendMessage threw:', err);
    if (!uiAppliedPosts.has(post)) {
      applyVibeUI(post, 'safe', 'Extension context lost.');
    }
  }
};

// ── Apply Vibe UI ────────────────────────────────────────────
// Traffic-light dot + tooltip + optional blur. Class names are locked.
const applyVibeUI = (post, vibe, reasoning = '') => {
  // Guard: don't inject twice (DOM check + Set check for race conditions)
  if (uiAppliedPosts.has(post)) return;
  if (post.querySelector('.vibe-check-dot')) return;
  uiAppliedPosts.add(post);
  post.setAttribute('data-vibe-processed', 'true');

  // Ensure positioning context for the dot
  post.classList.add('vibe-post-container');

  const dot = document.createElement('div');
  dot.classList.add('vibe-check-dot');

  if (vibe === 'safe') {
    dot.classList.add('vibe-safe');
  } else if (vibe === 'warning') {
    dot.classList.add('vibe-warning');
  } else if (vibe === 'intense') {
    dot.classList.add('vibe-intense');
    post.classList.add('vibe-blurred');

    // Create dynamic blur overlay
    const overlay = document.createElement('div');
    overlay.classList.add('vibe-blur-overlay');

    const overlayCard = document.createElement('div');
    overlayCard.classList.add('vibe-blur-card');

    const icon = document.createElement('span');
    icon.classList.add('vibe-blur-icon');

    const text = document.createElement('p');
    text.classList.add('vibe-blur-reasoning');
    text.textContent = reasoning || 'Content flagged as intense.';

    const cta = document.createElement('p');
    cta.classList.add('vibe-blur-cta');
    cta.textContent = 'Click anywhere to reveal';

    overlayCard.appendChild(icon);
    overlayCard.appendChild(text);
    overlayCard.appendChild(cta);
    overlay.appendChild(overlayCard);
    post.appendChild(overlay);

    // Click-to-unblur (capture phase, one-shot)
    const removeBlur = (e) => {
      if (!post.classList.contains('vibe-blurred')) return;
      e.preventDefault();
      e.stopPropagation();
      post.classList.remove('vibe-blurred');

      // Smoothly animate the backdrop-filter and overlay out
      overlay.style.backdropFilter = 'blur(0px) saturate(1)';
      overlay.style.webkitBackdropFilter = 'blur(0px) saturate(1)';
      overlay.style.opacity = '0';
      overlay.style.transition = 'backdrop-filter 0.5s ease, -webkit-backdrop-filter 0.5s ease, opacity 0.5s ease';

      setTimeout(() => overlay.remove(), 500);
      post.removeEventListener('click', removeBlur, true);
    };
    post.addEventListener('click', removeBlur, true);

    // ── Sidebar Lockdown Mode ─────────────────────────────
    // If a main post is intense on a comment page, lock down the sidebar.
    if (window.location.href.includes('/comments/')) {
      document.body.classList.add('vibe-lockdown-active');
    }
  }

  // ── AI Transparency Tooltip ─────────────────────────────
  if (reasoning) {
    const tooltip = document.createElement('span');
    tooltip.classList.add('vibe-tooltip');
    tooltip.textContent = reasoning;
    dot.appendChild(tooltip);
  }

  post.appendChild(dot);
};

// ── MutationObserver — detect dynamically loaded posts ───────
// Debounced to avoid hammering the DOM on Reddit's aggressive
// virtual-scroll rerenders.
let mutationTimer = null;

const scanForNewPosts = () => {
  if (window.location.href.includes('/search')) return;

  const posts = document.querySelectorAll(POST_SELECTOR);
  for (const post of posts) {
    if (!processedPosts.has(post)) {
      observer.observe(post);
    }
  }
};

const mutationObserver = new MutationObserver(() => {
  // Debounce: Reddit fires hundreds of mutations during scroll.
  // Batch them into a single scan every 200ms.
  if (mutationTimer) clearTimeout(mutationTimer);
  mutationTimer = setTimeout(scanForNewPosts, 200);
});

// ── Bootstrap ────────────────────────────────────────────────
mutationObserver.observe(document.body, { childList: true, subtree: true });
scanForNewPosts();

// Delayed rescan — catches late-rendering Reddit search results
// and lazily-loaded feeds that the MutationObserver may miss.
setTimeout(scanForNewPosts, 1000);

// ── Global Sidebar Unblur Listener ────────────────────────────
document.addEventListener('click', (e) => { 
  if (document.body.classList.contains('vibe-lockdown-active')) { 
    const sidebar = e.target.closest('div[data-slug="pdp_right_rail_related"], shreddit-sidebar, [slot="right-sidebar"]'); 
    if (sidebar) { 
      e.preventDefault(); 
      e.stopPropagation(); 
      document.body.classList.remove('vibe-lockdown-active'); 
    } 
  } 
}, true);
