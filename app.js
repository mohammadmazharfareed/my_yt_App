const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const dns = require('dns');
const cluster = require('cluster');
require('dotenv').config();
const app = express();
const path = require('path');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const os = require('os');
const ytdlp = require('yt-dlp-exec');

// Short-lived cache for progressive (muxed) direct URLs
const progressiveUrlCache = new Map();
const PROG_URL_TTL_MS = 10 * 60 * 1000; // 10 minutes
function setProgressiveCache(cacheKey, value) {
    progressiveUrlCache.set(cacheKey, { value, ts: Date.now() });
}
function getProgressiveCache(cacheKey) {
    const entry = progressiveUrlCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.ts > PROG_URL_TTL_MS) {
        progressiveUrlCache.delete(cacheKey);
        return null;
    }
    return entry.value;
}

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Support multiple API keys with automatic rotation
const YOUTUBE_API_KEYS = (process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || "AIzaSyBSCDecnCAu3uNK3AKSCMwmJLGRN36L3xE,AIzaSyCBnc7LJB3MS68D4zDWjgu8cBwoAcV7KIc")
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);
let YOUTUBE_CURRENT_KEY_INDEX = 0;
function getActiveApiKey() {
    return YOUTUBE_API_KEYS[YOUTUBE_CURRENT_KEY_INDEX] || "";
}
function rotateApiKeyTo(index) {
    if (YOUTUBE_API_KEYS.length === 0) return;
    YOUTUBE_CURRENT_KEY_INDEX = index % YOUTUBE_API_KEYS.length;
}
function hasMultipleApiKeys() {
    return YOUTUBE_API_KEYS.length > 1;
}
const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3';

// Allow selecting an initial key via env (1-based index for convenience)
try {
    const envIdxRaw = process.env.YOUTUBE_KEY_INDEX || process.env.YOUTUBE_ACTIVE_KEY_INDEX;
    const envIdx = parseInt(envIdxRaw || '', 10);
    if (!Number.isNaN(envIdx) && envIdx >= 1 && envIdx <= YOUTUBE_API_KEYS.length) {
        YOUTUBE_CURRENT_KEY_INDEX = envIdx - 1;
    }
} catch (_) { /* noop */ }
console.log(`YouTube API keys configured: ${YOUTUBE_API_KEYS.length}. Active key: #${YOUTUBE_CURRENT_KEY_INDEX + 1}`);

// ===== API OPTIMIZATION & CACHING SYSTEM =====
// In-memory cache for API responses (in production, use Redis)
const apiCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE = 1000; // Maximum cache entries

// Rate limiting for API calls
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 50; // Conservative limit

// API quota tracking
let dailyQuotaUsed = 0;
const QUOTA_RESET_TIME = 24 * 60 * 60 * 1000; // 24 hours
const MAX_DAILY_QUOTA = 10000; // YouTube API daily quota

// Helper function to get cache key
function getCacheKey(endpoint, params) {
    return `${endpoint}_${JSON.stringify(params)}`;
}

// Helper function to check if cache is valid
function isCacheValid(entry) {
    const ttl = typeof entry.ttlMs === 'number' ? entry.ttlMs : CACHE_DURATION;
    return Date.now() - entry.timestamp < ttl;
}

// Helper function to clean old cache entries
function cleanCache() {
    const now = Date.now();
    for (const [key, value] of apiCache.entries()) {
        const ttl = typeof value.ttlMs === 'number' ? value.ttlMs : CACHE_DURATION;
        if (now - value.timestamp > ttl) {
            apiCache.delete(key);
        }
    }

    // If cache is still too large, remove oldest entries
    if (apiCache.size > MAX_CACHE_SIZE) {
        const entries = Array.from(apiCache.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, Math.floor(MAX_CACHE_SIZE * 0.2)); // Remove 20% of oldest entries
        toRemove.forEach(([key]) => apiCache.delete(key));
    }
}

// Rate limiting function
function checkRateLimit(identifier) {
    const now = Date.now();
    const userRequests = rateLimiter.get(identifier) || [];

    // Remove old requests outside the window
    const validRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);

    if (validRequests.length >= MAX_REQUESTS_PER_MINUTE) {
        return false; // Rate limited
    }

    validRequests.push(now);
    rateLimiter.set(identifier, validRequests);
    return true; // Allowed
}

// Optimized API call function with caching and rate limiting
function computeCacheTtl(endpoint, params) {
    // Default cache duration
    let ttl = CACHE_DURATION;
    try {
        if (endpoint === 'playlistItems') {
            // Uploads playlist should refresh quickly to reflect newest videos
            ttl = 60 * 1000; // 1 minute
        } else if (endpoint === 'search') {
            // Channel latest videos via date ordering should also refresh quickly
            if (params && params.order === 'date' && params.channelId) {
                ttl = 60 * 1000; // 1 minute
            }
        }
    } catch (_) { /* noop */ }
    return ttl;
}

// Prefer IPv4 to avoid IPv6 timeouts on some networks
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* best-effort */ }

// Pooled axios client for better concurrency
const axiosClient = axios.create({
    timeout: 12000,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 128 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 128 })
});

// Resiliency settings for YouTube API calls
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_API_RETRIES = 3;
const BASE_BACKOFF_MS = 400;
const ENDPOINT_TIMEOUT_MS = {
    search: 20000,
    videos: 15000,
    channels: 15000,
    playlistItems: 18000,
    videoCategories: 15000,
    default: 15000
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
    if (!error) return false;
    // Axios timeout or common transient network errors
    if (error.code && ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(error.code)) return true;
    if (error.response && RETRYABLE_STATUS_CODES.has(error.response.status)) return true;
    // Axios network error without response
    if (error.isAxiosError && !error.response) return true;
    return false;
}

function isQuotaOrRateLimitError(error) {
    if (!error) return false;
    const status = error?.response?.status;
    const msg = (error?.response?.data?.error?.message || error?.message || '').toLowerCase();
    return status === 403 || status === 429 || msg.includes('quota') || msg.includes('rate limit');
}

// Trim API responses to essential fields to reduce payload and latency
function maybeAddFieldsParam(endpoint, params) {
    const next = { ...(params || {}) };
    try {
        const part = (next.part || '').toString().toLowerCase();
        if (!next.fields && part.includes('snippet')) {
            if (endpoint === 'search') {
                next.fields = 'items(id/videoId,snippet(title,description,thumbnails(default(url),high(url)),channelTitle,publishedAt)),nextPageToken';
            } else if (endpoint === 'videos') {
                next.fields = 'items(id,snippet(title,description,thumbnails(default(url),high(url)),channelTitle,publishedAt))';
            } else if (endpoint === 'playlistItems') {
                next.fields = 'items(snippet(publishedAt,resourceId/videoId,title,description,thumbnails(default(url),high(url)))),nextPageToken';
            }
        }
    } catch (_) { /* noop */ }
    return next;
}

async function optimizedApiCall(endpoint, params, identifier = 'default') {
    const cacheKey = getCacheKey(endpoint, params);
    let staleEntry = null;

    // Check cache first
    if (apiCache.has(cacheKey)) {
        const cached = apiCache.get(cacheKey);
        if (isCacheValid(cached)) {
            console.log(`Cache hit for ${endpoint}`);
            console.log(`Cached data structure:`, Object.keys(cached.data));
            return cached.data;
        } else {
            console.log(`Cache expired for ${endpoint}`);
            // Keep a reference to stale data to serve on failure
            staleEntry = cached;
            apiCache.delete(cacheKey);
        }
    }

    // Check rate limit
    if (!checkRateLimit(identifier)) {
        throw new Error('Rate limit exceeded. Please try again later.');
    }

    // Check daily quota
    if (dailyQuotaUsed >= MAX_DAILY_QUOTA) {
        throw new Error('Daily API quota exceeded. Please try again tomorrow.');
    }

    try {
        // Guard: Ensure API key is configured
        if (!getActiveApiKey() || typeof getActiveApiKey() !== 'string' || getActiveApiKey().trim().length === 0) {
            throw new Error('Missing YOUTUBE_API_KEY. Set it in a .env file or environment variables.');
        }
        const baseTimeout = ENDPOINT_TIMEOUT_MS[endpoint] || ENDPOINT_TIMEOUT_MS.default;
        const preparedParams = maybeAddFieldsParam(endpoint, params);

        const keys = YOUTUBE_API_KEYS.length ? YOUTUBE_API_KEYS : [''];
        const startIdx = YOUTUBE_CURRENT_KEY_INDEX % keys.length;
        let lastError = null;

        // Try each key in the pool (if multiple), and for each key allow network retries
        for (let k = 0; k < keys.length; k++) {
            const keyIndex = (startIdx + k) % keys.length;
            const apiKey = keys[keyIndex];

            for (let attempt = 0; attempt < MAX_API_RETRIES; attempt++) {
                const attemptNum = attempt + 1;
                const perAttemptTimeout = baseTimeout + attempt * 5000; // increase on each retry
                try {
                    console.log(`API call to ${endpoint} with key#${keyIndex + 1}/${keys.length} (attempt ${attemptNum}/${MAX_API_RETRIES})`);
                    const response = await axiosClient.get(`${YOUTUBE_API_URL}/${endpoint}`, {
                        params: sanitizeParams({
                            ...preparedParams,
                            key: apiKey
                        }),
                        timeout: perAttemptTimeout,
                        family: 4,
                        validateStatus: s => s >= 200 && s < 300
                    });

                    if (!response.data) {
                        throw new Error('No data received from YouTube API');
                    }

                    // Cache the response with per-endpoint TTL
                    apiCache.set(cacheKey, {
                        data: response.data,
                        timestamp: Date.now(),
                        ttlMs: computeCacheTtl(endpoint, params)
                    });

                    // Track quota usage (estimate: 1-100 units per call depending on endpoint)
                    const quotaCost = estimateQuotaCost(endpoint, params);
                    dailyQuotaUsed += quotaCost;

                    // Update the active key index on success
                    rotateApiKeyTo(keyIndex);

                    // Clean cache periodically
                    if (Math.random() < 0.1) { // 10% chance to clean cache
                        cleanCache();
                    }

                    return response.data;
                } catch (err) {
                    lastError = err;
                    const quotaErr = isQuotaOrRateLimitError(err);
                    const retryableNet = isRetryableNetworkError(err) && attempt < (MAX_API_RETRIES - 1);

                    console.error(`API call failed for ${endpoint} with key#${keyIndex + 1}:`, err.message);

                    // If quota/rate limit issue, break to next key (if any)
                    if (quotaErr) {
                        console.warn('Quota or rate limit encountered. Trying next API key if available...');
                        break; // try next key in the outer loop
                    }

                    if (retryableNet) {
                        let delay = BASE_BACKOFF_MS * Math.pow(2, attempt);
                        const ra = Number(err?.response?.headers?.['retry-after'] || 0);
                        if (!Number.isNaN(ra) && ra > 0) delay = Math.max(delay, ra * 1000);
                        delay += Math.floor(Math.random() * 200); // jitter
                        await sleep(delay);
                        continue; // retry same key
                    }

                    // If not retrying further and we have stale cache, serve it
                    if (staleEntry && staleEntry.data) {
                        console.warn(`Serving stale cache for ${endpoint} due to error: ${err.message}`);
                        return staleEntry.data;
                    }

                    // No further retries for this key; rethrow and let outer key loop handle
                    // If this was a permanent error (e.g., 400), it will bubble up immediately
                    throw err;
                }
            }
            // On to next key if inner loop didn't return
        }

        // Exhausted all keys and retries
        throw lastError || new Error('Unknown error calling YouTube API');
    } catch (error) {
        console.error(`API call failed for ${endpoint}:`, error.message);

        // Handle specific API errors
        if (error.response) {
            const apiMessage = error.response.data && error.response.data.error && error.response.data.error.message
                ? error.response.data.error.message
                : null;
            if (error.response.status === 403) {
                throw new Error(apiMessage || 'YouTube API quota exceeded or invalid API key');
            } else if (error.response.status === 400) {
                // Forward YouTube's own error message when available for easier debugging
                throw new Error(apiMessage || 'Invalid request parameters');
            } else if (error.response.status === 404) {
                throw new Error(apiMessage || 'Resource not found');
            } else if (RETRYABLE_STATUS_CODES.has(error.response.status)) {
                throw new Error(apiMessage || `Transient API error (${error.response.status})`);
            }
        }

        throw error;
    }
}

// Estimate quota cost for different API calls
function estimateQuotaCost(endpoint, params) {
    const baseCosts = {
        'search': 100,
        'videos': 1,
        'channels': 1,
        'playlistItems': 1,
        'videoCategories': 1
    };

    const baseCost = baseCosts[endpoint] || 100;

    // Adjust based on parameters
    if (params.maxResults) {
        return Math.min(baseCost, 100); // Max 100 units per call
    }

    return baseCost;
}

// Reset daily quota counter (run every 24 hours)
setInterval(() => {
    dailyQuotaUsed = 0;
    console.log('Daily API quota reset');
}, QUOTA_RESET_TIME);

// Clean cache every 5 minutes
setInterval(cleanCache, 5 * 60 * 1000);

// ===== END OPTIMIZATION SYSTEM =====

// ===== ADDITIONAL OPTIMIZATION FEATURES =====

// Batch processing for multiple video details
const batchQueue = new Map();
const BATCH_SIZE = 50; // YouTube API allows up to 50 IDs per request
const BATCH_TIMEOUT = 1000; // 1 second to wait for more requests

// Batch processor
async function processBatch() {
    for (const [batchKey, batch] of batchQueue.entries()) {
        if (batch.ids.length > 0 && (batch.ids.length >= BATCH_SIZE || Date.now() - batch.timestamp > BATCH_TIMEOUT)) {
            try {
                const ids = batch.ids.splice(0, BATCH_SIZE);
                const response = await optimizedApiCall('videos', {
                    part: 'snippet',
                    id: ids.join(',')
                });

                // Resolve all promises in this batch
                batch.promises.forEach((resolve, index) => {
                    if (response.items && response.items[index]) {
                        resolve(response.items[index]);
                    } else {
                        resolve(null);
                    }
                });

                batch.promises = [];

                // If there are more IDs in the batch, keep it in the queue
                if (batch.ids.length === 0) {
                    batchQueue.delete(batchKey);
                } else {
                    batch.timestamp = Date.now();
                }
            } catch (error) {
                // Reject all promises in this batch
                batch.promises.forEach((resolve, reject) => {
                    reject(error);
                });
                batchQueue.delete(batchKey);
            }
        }
    }
}

// Run batch processor every 500ms
setInterval(processBatch, 500);

// Intelligent search suggestions cache
const searchSuggestionsCache = new Map();
const SUGGESTION_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// Get search suggestions (reduces API calls for common searches)
function getSearchSuggestions(query) {
    const normalizedQuery = query.toLowerCase().trim();

    // Check cache first
    if (searchSuggestionsCache.has(normalizedQuery)) {
        const cached = searchSuggestionsCache.get(normalizedQuery);
        if (Date.now() - cached.timestamp < SUGGESTION_CACHE_DURATION) {
            return cached.suggestions;
        }
    }

    // Generate suggestions based on query patterns
    const suggestions = [];
    const words = normalizedQuery.split(' ');

    if (words.length > 1) {
        // Add partial queries
        for (let i = words.length - 1; i > 0; i--) {
            suggestions.push(words.slice(0, i).join(' '));
        }
    }

    // Add common variations
    if (normalizedQuery.includes('music')) {
        suggestions.push(normalizedQuery.replace('music', 'song'));
        suggestions.push(normalizedQuery.replace('music', 'audio'));
    }

    if (normalizedQuery.includes('video')) {
        suggestions.push(normalizedQuery.replace('video', 'clip'));
        suggestions.push(normalizedQuery.replace('video', 'footage'));
    }

    // Cache suggestions
    searchSuggestionsCache.set(normalizedQuery, {
        suggestions: suggestions.slice(0, 5), // Limit to 5 suggestions
        timestamp: Date.now()
    });

    return suggestions;
}

// Quota management dashboard
app.get('/api/quota-status', (req, res) => {
    const quotaPercentage = (dailyQuotaUsed / MAX_DAILY_QUOTA) * 100;
    const cacheStats = {
        size: apiCache.size,
        maxSize: MAX_CACHE_SIZE,
        hitRate: 0 // Would need to track hits/misses for accurate rate
    };

    res.json({
        dailyQuotaUsed,
        maxDailyQuota: MAX_DAILY_QUOTA,
        quotaPercentage: Math.round(quotaPercentage * 100) / 100,
        quotaRemaining: MAX_DAILY_QUOTA - dailyQuotaUsed,
        cacheStats,
        rateLimitStatus: 'active'
    });
});

// Optimized search with suggestions
app.get('/api/search-suggestions', (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.json({ suggestions: [] });
    }

    const suggestions = getSearchSuggestions(query);
    res.json({ suggestions });
});

// ===== END ADDITIONAL OPTIMIZATION FEATURES =====

// ===== END OPTIMIZATION SYSTEM =====

// Helper function to extract video ID from YouTube URL
function extractVideoId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

// Helper: Validate YouTube channel ID format (starts with UC, length 24)
function isValidChannelId(channelId) {
    return typeof channelId === 'string' && /^UC[0-9A-Za-z_-]{22}$/.test(channelId);
}

// Helper: Remove undefined, null, or empty-string params
function sanitizeParams(params) {
    const sanitized = {};
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        sanitized[key] = value;
    }
    return sanitized;
}

// Helper: pick best audio format with language preference when available
function pickBestAudioFormat(formats, preferredLang = 'auto') {
    const audioOnly = (formats || []).filter(f => (f.hasAudio || f.audioBitrate) && !f.hasVideo);
    if (audioOnly.length === 0) return null;

    const normalizeLang = (fmt) => {
        const l = (fmt.language || fmt.languageCode || fmt.lang || (fmt.audioTrack && (fmt.audioTrack.language || fmt.audioTrack.locale)) || '').toString().toLowerCase();
        return l;
    };
    const isDefaultTrack = (fmt) => !!(fmt.isDefault || (fmt.audioTrack && (fmt.audioTrack.audioIsDefault || fmt.audioTrack.isDefault)));

    const target = (preferredLang || 'auto').toLowerCase();

    const scored = audioOnly.map(fmt => {
        const lang = normalizeLang(fmt);
        const preferredMatch = (target !== 'auto') && lang && (lang === target || lang.startsWith(target + '-')) ? 1 : 0;
        const englishFallback = (target !== 'auto') && !preferredMatch && target.startsWith('en') && lang && lang.startsWith('en') ? 1 : 0;
        const defaultFlag = isDefaultTrack(fmt) ? 1 : 0;
        const mp4Container = fmt.container === 'mp4' ? 1 : 0;
        const abr = Number(fmt.audioBitrate || 0);
        return { fmt, score: [preferredMatch, defaultFlag, englishFallback, mp4Container, abr], lang };
    });

    scored.sort((a, b) => {
        for (let i = 0; i < a.score.length; i++) {
            if (b.score[i] !== a.score[i]) return b.score[i] - a.score[i];
        }
        return 0;
    });

    return scored[0]?.fmt || audioOnly.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] || null;
}

// Helper function to get time ago string
function getTimeAgo(publishedAt) {
    const now = new Date();
    const published = new Date(publishedAt);
    const diffInSeconds = Math.floor((now - published) / 1000);

    if (diffInSeconds < 60) {
        return `${diffInSeconds} seconds ago`;
    } else if (diffInSeconds < 3600) {
        const minutes = Math.floor(diffInSeconds / 60);
        return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 86400) {
        const hours = Math.floor(diffInSeconds / 3600);
        return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else {
        const days = Math.floor(diffInSeconds / 86400);
        return `${days} day${days > 1 ? 's' : ''} ago`;
    }
}

// Helper: Get uploads playlist ID for a channel
async function getUploadsPlaylistId(channelId) {
    const resp = await optimizedApiCall('channels', {
        part: 'contentDetails,snippet',
        id: channelId
    });
    if (!resp.items || resp.items.length === 0) return null;
    return resp.items[0].contentDetails?.relatedPlaylists?.uploads || null;
}

// Helper: Fetch videos from uploads playlist (freshest possible)
async function fetchUploadsVideos(playlistId, { pageToken = '', maxResults = 10 } = {}) {
    const resp = await optimizedApiCall('playlistItems', {
        part: 'snippet',
        playlistId,
        maxResults,
        pageToken
    });
    const items = (resp.items || []).map(item => {
        const vId = item.snippet?.resourceId?.videoId;
        return {
            id: vId,
            title: item.snippet?.title,
            description: item.snippet?.description,
            url: vId ? `https://www.youtube.com/watch?v=${vId}` : '',
            thumbnail: item.snippet?.thumbnails?.default?.url || item.snippet?.thumbnails?.high?.url || '',
            publishedAt: item.snippet?.publishedAt
        };
    }).filter(v => !!v.id);
    return { items, nextPageToken: resp.nextPageToken || null };
}

function filterVideosByQuery(videos, query) {
    if (!query) return videos;
    const q = query.toLowerCase();
    return videos.filter(v => (v.title || '').toLowerCase().includes(q) || (v.description || '').toLowerCase().includes(q));
}

// Helper: Normalize names for fuzzy channel-title comparisons
function normalizeForComparison(input) {
    if (!input) return '';
    return String(input)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(the|official|channel|tv|videos)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function channelTitleMatches(userQuery, channelTitle) {
    const nq = normalizeForComparison(userQuery);
    const nt = normalizeForComparison(channelTitle);
    if (!nq || !nt) return false;
    return nt === nq || nt.includes(nq) || nq.includes(nt);
}

// Set EJS as the template engine
app.set('view engine', 'ejs');
// Set the views directory explicitly
app.set('views', path.join(__dirname, 'Views'));

// Serve static files
app.use(express.static(path.join(__dirname, 'Public')));

// Make YouTube API key available to views
app.use((req, res, next) => {
    res.locals.YOUTUBE_API_KEY = getActiveApiKey();
    next();
});

// Home Route
app.get('/', (req, res) => {
    res.render('index', { videos: [], nextPageToken: null, query: '' });
});

// Channel Search Route
app.get('/search-channel', async (req, res) => {
    const channelQuery = req.query.channelQuery;

    if (!channelQuery) {
        return res.render('index', { videos: [], channels: [], nextPageToken: null, query: '' });
    }

    try {
        // First, search for the channel
        const channelResponse = await optimizedApiCall('search', {
            part: 'snippet',
            q: channelQuery,
            type: 'channel',
            maxResults: 5
        });

        const channels = (channelResponse.items || []).map(channel => ({
            id: channel.id.channelId,
            title: channel.snippet.title,
            description: channel.snippet.description,
            thumbnail: channel.snippet.thumbnails.default.url
        }));

        // If we found channels, get the latest videos from the first channel using multiple approaches for maximum real-time coverage
        if (channels.length > 0) {
            const channelId = channels[0].id;

            // Prefer uploads playlist for most up-to-date ordering
            let videos = [];
            try {
                const uploadsPlaylistId = await getUploadsPlaylistId(channelId);
                if (uploadsPlaylistId) {
                    const { items } = await fetchUploadsVideos(uploadsPlaylistId, { maxResults: 20 });
                    // Do not filter by query here; show freshest uploads as-is
                    videos = items.map(v => ({
                        ...v,
                        publishedAt: new Date(v.publishedAt)
                    }));
                }
            } catch (e) {
                console.warn('Uploads playlist fetch failed, falling back to search:', e.message);
            }

            // Fallback to search endpoint ordered by date if uploads not available
            if (videos.length === 0) {
                const videosResponse = await optimizedApiCall('search', {
                    part: 'snippet',
                    channelId: channelId,
                    order: 'date',
                    type: 'video',
                    maxResults: 20
                });
                if (videosResponse.items && videosResponse.items.length > 0) {
                    videos = videosResponse.items.map(video => ({
                        id: video.id.videoId,
                        title: video.snippet.title,
                        description: video.snippet.description,
                        url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
                        thumbnail: video.snippet.thumbnails.default.url,
                        publishedAt: new Date(video.snippet.publishedAt)
                    }));
                }
            }

            // Sort videos by date in descending order (newest first)
            videos.sort((a, b) => b.publishedAt - a.publishedAt);
            videos = videos.slice(0, 10);
            videos = videos.map(video => ({
                ...video,
                publishedAt: video.publishedAt.toISOString(),
                formattedDate: video.publishedAt.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                }),
                timeAgo: getTimeAgo(video.publishedAt)
            }));

            return res.render('index', {
                videos,
                channels,
                nextPageToken: null,
                query: '',
                selectedChannelId: channelId,
                channelTitle: channels[0].title,
                searchType: 'channel'
            });
        }

        res.render('index', { videos: [], channels, nextPageToken: null, query: '' });
    } catch (error) {
        console.error('Error fetching YouTube channels:', error.message);
        res.render('index', { videos: [], channels: [], nextPageToken: null, query: '' });
    }
});

// Advanced Search Route (Title-based search)
app.get('/advanced-search', async (req, res) => {
    const titleQuery = req.query.title;
    const order = req.query.order || 'date';
    const maxResults = parseInt(req.query.maxResults || '10');
    const pageToken = req.query.pageToken || '';

    if (!titleQuery) {
        return res.render('index', {
            videos: [],
            nextPageToken: null,
            title: '',
            order,
            maxResults: maxResults.toString(),
            searchType: 'title',
            query: ''
        });
    }

    try {
        // Set up parameters for the title-based video search
        const videoParams = {
            part: 'snippet',
            q: titleQuery,
            order: order,
            type: 'video',
            maxResults: maxResults,
            pageToken
        };

        const videoResponse = await optimizedApiCall('search', videoParams);

        const videos = (videoResponse.items || []).map(video => ({
            id: video.id.videoId,
            title: video.snippet.title,
            description: video.snippet.description,
            url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
            thumbnail: video.snippet.thumbnails.default.url
        }));

        const nextPageToken = videoResponse.nextPageToken || null;

        res.render('index', {
            videos,
            nextPageToken,
            title: titleQuery,
            order,
            maxResults: maxResults.toString(),
            searchType: 'title',
            query: ''
        });
    } catch (error) {
        console.error('Error fetching YouTube data:', error.message);
        res.render('index', {
            videos: [],
            nextPageToken: null,
            title: titleQuery,
            order,
            maxResults: maxResults.toString(),
            searchType: 'title',
            query: ''
        });
    }
});

// JSON API: Advanced Search (infinite scroll)
app.get('/api/advanced-search', async (req, res) => {
    const titleQuery = req.query.title;
    const order = req.query.order || 'date';
    const maxResults = parseInt(req.query.maxResults || '10');
    const pageToken = req.query.pageToken || '';

    if (!titleQuery) {
        return res.json({ success: true, videos: [], nextPageToken: null });
    }

    try {
        const videoParams = {
            part: 'snippet',
            q: titleQuery,
            order,
            type: 'video',
            maxResults,
            pageToken
        };

        const videoResponse = await optimizedApiCall('search', videoParams);

        const videos = (videoResponse.items || []).map(video => ({
            id: video.id.videoId,
            title: video.snippet.title,
            description: video.snippet.description,
            url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
            thumbnail: video.snippet.thumbnails.default.url
        }));

        const nextPageTokenResp = videoResponse.nextPageToken || null;

        res.json({ success: true, videos, nextPageToken: nextPageTokenResp });
    } catch (error) {
        console.error('API /api/advanced-search error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch more videos' });
    }
});

// Search Route
app.get('/search', async (req, res) => {
    const searchQuery = req.query.q;
    const pageToken = req.query.pageToken || '';
    const explicitChannelId = req.query.channelId;

    if (!searchQuery) {
        return res.render('index', { videos: [], nextPageToken: null, query: '' });
    }

    try {
        let channelId = explicitChannelId || null;
        const likelyChannelQuery = searchQuery && searchQuery.trim().split(' ').length <= 5;
        let channelTitle = '';

        // If no explicit channelId is provided, try to detect from mappings or query
        if (!channelId) {
            // Mapping for specific keywords to channel IDs (e.g., for Hum TV)
            // Prefer environment variable over placeholder; ignore invalid placeholders
            const mapping = {
                'dill wali gali': process.env.HUM_TV_CHANNEL_ID,
                'hum tv': process.env.HUM_TV_CHANNEL_ID
            };

            // Check if the search query contains any mapping keyword
            for (const key in mapping) {
                if (searchQuery.toLowerCase().includes(key)) {
                    const mapped = mapping[key];
                    if (isValidChannelId(mapped)) {
                        channelId = mapped;
                        channelTitle = key; // Simple mapping for demo
                    }
                    break;
                }
            }

            // If no mapping was found, and if the query appears to be a channel name (e.g. very short query), try to detect it
            if (!channelId && searchQuery.trim().split(' ').length <= 5) {
                // Search for up to 5 channels and pick the one that best matches the typed name
                const channelResponse = await optimizedApiCall('search', {
                    part: 'snippet',
                    q: searchQuery,
                    type: 'channel',
                    maxResults: 5
                });
                if (channelResponse.items && channelResponse.items.length > 0) {
                    // Prefer exact/close title matches
                    let best = channelResponse.items[0];
                    for (const item of channelResponse.items) {
                        const title = item?.snippet?.title || '';
                        if (channelTitleMatches(searchQuery, title)) {
                            best = item;
                            break;
                        }
                    }
                    channelId = best.id.channelId;
                    channelTitle = best.snippet.title;
                }
            }

            // If still no channel found, infer from top video results by picking the dominant channel
            if (!channelId) {
                try {
                    const videosProbe = await optimizedApiCall('search', {
                        part: 'snippet',
                        q: searchQuery,
                        type: 'video',
                        maxResults: 10,
                        order: 'relevance'
                    });
                    const counts = {};
                    for (const it of (videosProbe.items || [])) {
                        const cid = it?.snippet?.channelId;
                        const ctitle = it?.snippet?.channelTitle;
                        if (!cid) continue;
                        counts[cid] = (counts[cid] || 0) + (channelTitleMatches(searchQuery, ctitle) ? 2 : 1);
                    }
                    let bestCid = null; let bestScore = 0;
                    for (const [cid, score] of Object.entries(counts)) {
                        if (score > bestScore) { bestScore = score; bestCid = cid; }
                    }
                    if (bestCid) {
                        channelId = bestCid;
                        try {
                            const ch = await optimizedApiCall('channels', { part: 'snippet', id: bestCid });
                            channelTitle = ch?.items?.[0]?.snippet?.title || channelTitle || '';
                        } catch { /* ignore */ }
                    }
                } catch (e) {
                    console.warn('Channel inference from videos failed:', e.message);
                }
            }
        }

        // If an explicit channelId was provided, fetch the channel title
        if (explicitChannelId && !channelTitle) {
            try {
                const channelDetailsResponse = await optimizedApiCall('channels', {
                    part: 'snippet',
                    id: explicitChannelId
                });

                if (channelDetailsResponse.items.length > 0) {
                    channelTitle = channelDetailsResponse.items[0].snippet.title;
                }
            } catch (error) {
                console.error('Error fetching channel details:', error.message);
            }
        }

        // Set up parameters for the video search
        // In channel mode, avoid q to prevent cross-channel results; otherwise include it
        let videoParams = {
            part: 'snippet',
            order: 'date', // Most recent videos first
            type: 'video',
            maxResults: 25,
            pageToken
        };
        if (!channelId) {
            videoParams.q = searchQuery;
        }

        let videos = [];
        let nextPageToken = null;

        // When searching within a channel, prefer the uploads playlist for freshest videos,
        // then filter by the search query client-side for relevance.
        if (channelId && isValidChannelId(channelId)) {
            try {
                const uploadsPlaylistId = await getUploadsPlaylistId(channelId);
                if (uploadsPlaylistId) {
                    const { items, nextPageToken: np } = await fetchUploadsVideos(uploadsPlaylistId, { maxResults: 20, pageToken });
                    // Use channel uploads only and sort newest→oldest explicitly
                    videos = (items || []).slice().sort((a, b) => {
                        const da = new Date(a.publishedAt || 0).getTime();
                        const db = new Date(b.publishedAt || 0).getTime();
                        return db - da;
                    });
                    nextPageToken = np || null;
                }
            } catch (e) {
                console.warn('Uploads playlist path failed, falling back to search in channel:', e.message);
            }
        }

        // Fallback to YouTube search endpoint if not in channel mode or uploads failed/empty
        if (videos.length === 0) {
            // If the user typed what looks like a channel name but we couldn't resolve a channel,
            // fall back to a strict client-side channel filter using channelTitle to avoid unrelated results.
            if (!channelId && likelyChannelQuery) {
                try {
                    const resp = await optimizedApiCall('search', {
                        part: 'snippet',
                        q: searchQuery,
                        type: 'video',
                        order: 'date',
                        maxResults: 25,
                        pageToken
                    });
                    const filtered = (resp.items || []).filter(v => channelTitleMatches(searchQuery, v?.snippet?.channelTitle));
                    const mapped = filtered.map(video => ({
                        id: video.id.videoId,
                        title: video.snippet.title,
                        description: video.snippet.description,
                        url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
                        thumbnail: video.snippet.thumbnails?.default?.url || video.snippet.thumbnails?.high?.url || ''
                    }));
                    if (mapped.length > 0) {
                        return res.render('index', {
                            videos: mapped,
                            nextPageToken: resp.nextPageToken || null,
                            query: searchQuery,
                            selectedChannelId: null,
                            channelTitle: '',
                            searchType: 'channel'
                        });
                    }
                } catch (e) {
                    console.warn('Strict channel filter fallback failed:', e.message);
                }
                return res.render('index', {
                    videos: [],
                    nextPageToken: null,
                    query: searchQuery,
                    selectedChannelId: null,
                    channelTitle: '',
                    searchType: 'channel'
                });
            }
            if (channelId && isValidChannelId(channelId)) {
                videoParams.channelId = channelId;
            } else {
                videoParams.q = searchQuery;
            }
            const videoResponse = await optimizedApiCall('search', videoParams);
            videos = (videoResponse.items || []).map(video => ({
                id: video.id.videoId,
                title: video.snippet.title,
                description: video.snippet.description,
                url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
                thumbnail: video.snippet.thumbnails?.default?.url || video.snippet.thumbnails?.high?.url || ''
            }));
            nextPageToken = videoResponse.nextPageToken || null;
        }

        // If no videos are found in channel mode, do not fall back to global results
        // This prevents mixing in random videos that only match the text
        if (videos.length === 0 && channelId) {
            return res.render('index', {
                videos: [],
                nextPageToken: null,
                query: searchQuery,
                selectedChannelId: channelId,
                channelTitle: channelTitle,
                searchType: 'channel'
            });
        }

        // Determine if we're in channel search mode
        const searchType = channelId ? 'channel' : null;

        res.render('index', {
            videos,
            nextPageToken,
            query: searchQuery,
            selectedChannelId: channelId,
            channelTitle: channelTitle,
            searchType
        });
    } catch (error) {
        console.error('Error fetching YouTube data:', error.message);
        if (error.response) {
            console.error('API error status:', error.response.status);
            console.error('API error data:', JSON.stringify(error.response.data));
        }
        res.render('index', { videos: [], nextPageToken: null, query: searchQuery, error: error.message });
    }
});

// JSON API: Search (infinite scroll)
app.get('/api/search', async (req, res) => {
    const searchQuery = req.query.q;
    const pageToken = req.query.pageToken || '';
    const explicitChannelId = req.query.channelId;
    const order = req.query.order || 'date';
    const titleChannelFilter = req.query.titleChannelFilter || '';

    if (!searchQuery) {
        return res.json({ success: true, videos: [], nextPageToken: null });
    }

    try {
        let channelId = explicitChannelId || null;

        if (!channelId && req.query.detectChannel === '1') {
            // Optional auto-detect channel when requested
            const channelResponse = await optimizedApiCall('search', {
                part: 'snippet', q: searchQuery, type: 'channel', maxResults: 1
            });
            if (channelResponse.items && channelResponse.items.length > 0) {
                channelId = channelResponse.items[0].id.channelId;
            }
        }

        let videoParams = {
            part: 'snippet',
            order,
            type: 'video',
            maxResults: 25,
            pageToken
        };
        if (!channelId) {
            videoParams.q = searchQuery;
        }

        if (channelId && isValidChannelId(channelId)) {
            videoParams.channelId = channelId;
        }

        let videosRespNext = null;
        let videos = [];

        if (channelId && isValidChannelId(channelId)) {
            try {
                const uploadsPlaylistId = await getUploadsPlaylistId(channelId);
                if (uploadsPlaylistId) {
                    const { items, nextPageToken: np } = await fetchUploadsVideos(uploadsPlaylistId, { maxResults: 20, pageToken });
                    // Do not filter by query in channel mode; show latest uploads only
                    videos = (items || []).slice().sort((a, b) => {
                        const da = new Date(a.publishedAt || 0).getTime();
                        const db = new Date(b.publishedAt || 0).getTime();
                        return db - da;
                    });
                    videosRespNext = np || null;
                }
            } catch (e) {
                console.warn('API uploads playlist failed (JSON):', e.message);
            }
        }

        if (videos.length === 0) {
            // For unresolved channel, still fetch but filter by channel title client-side for strictness
            const unresolvedChannel = !channelId && titleChannelFilter;
            if (channelId && isValidChannelId(channelId)) {
                videoParams.channelId = channelId;
            } else {
                videoParams.q = searchQuery;
            }
            const videoResponse = await optimizedApiCall('search', videoParams);
            let items = videoResponse.items || [];
            if (unresolvedChannel) {
                items = items.filter(v => channelTitleMatches(titleChannelFilter, v?.snippet?.channelTitle));
            }
            videos = items.map(video => ({
                id: video.id.videoId,
                title: video.snippet.title,
                description: video.snippet.description,
                url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
                thumbnail: video.snippet.thumbnails?.default?.url || video.snippet.thumbnails?.high?.url || ''
            }));
            videosRespNext = videoResponse.nextPageToken || null;
        }

        // Do not fall back to global results in channel mode to avoid cross-channel videos
        if (videos.length === 0 && channelId) {
            return res.json({ success: true, videos: [], nextPageToken: null });
        }

        res.json({ success: true, videos, nextPageToken: videosRespNext });
    } catch (error) {
        console.error('API /api/search error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch more videos' });
    }
});

// Test download endpoint
app.get('/test-download', async (req, res) => {
    try {
        const testVideoId = 'dQw4w9WgXcQ'; // Rick Roll video
        const videoUrl = `https://www.youtube.com/watch?v=${testVideoId}`;

        console.log('Testing download functionality...');

        // Validate the video URL
        if (!ytdl.validateURL(videoUrl)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        // Get video info
        const videoInfo = await ytdl.getInfo(videoUrl);
        const videoTitle = videoInfo.videoDetails.title;

        console.log('Video info retrieved successfully:', videoTitle);

        // Test creating a stream
        const videoStream = ytdl(videoUrl, {
            quality: 'lowest', // Use lowest quality for testing
            filter: 'videoandaudio'
        });

        if (videoStream) {
            console.log('Stream created successfully');

            // Set headers for a small test download
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="test_${testVideoId}.mp4"`);

            // Pipe only the first 1MB for testing
            let bytesDownloaded = 0;
            const maxBytes = 1024 * 1024; // 1MB

            videoStream.on('data', (chunk) => {
                bytesDownloaded += chunk.length;
                if (bytesDownloaded >= maxBytes) {
                    videoStream.destroy();
                    res.end();
                }
            });

            videoStream.pipe(res);

            videoStream.on('end', () => {
                console.log('Test download completed');
            });

            videoStream.on('error', (error) => {
                console.error('Test download error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Test download failed', details: error.message });
                }
            });
        } else {
            res.status(500).json({ error: 'Failed to create test stream' });
        }

    } catch (error) {
        console.error('Test download error:', error);
        res.status(500).json({ error: 'Test failed', details: error.message });
    }
});

// Test download page
app.get('/test-download-page', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Download Test</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                .test-section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 5px; }
                button { padding: 10px 20px; margin: 5px; background: #4CAF50; color: white; border: none; border-radius: 3px; cursor: pointer; }
                button:hover { background: #45a049; }
                .status { margin-top: 10px; padding: 10px; background: #f0f0f0; border-radius: 3px; }
            </style>
        </head>
        <body>
            <h1>Download Test Page</h1>
            
            <div class="test-section">
                <h3>Test Small Download (1MB)</h3>
                <button onclick="testSmallDownload()">Test Small Download</button>
                <div id="small-status" class="status"></div>
            </div>
            
            <div class="test-section">
                <h3>Test Direct Download</h3>
                <button onclick="testDirectDownload()">Test Direct Download</button>
                <div id="direct-status" class="status"></div>
            </div>
            
            <div class="test-section">
                <h3>Manual Download Links</h3>
                <p><a href="/test-download" target="_blank">Test Download (1MB)</a></p>
                <p><a href="/download-file?videoId=dQw4w9WgXcQ&format=mp4&quality=lowest" target="_blank">Test Video Download (Low Quality)</a></p>
            </div>
            
            <script>
                function testSmallDownload() {
                    const status = document.getElementById('small-status');
                    status.innerHTML = 'Testing small download...';
                    
                    fetch('/test-download')
                        .then(response => {
                            if (response.ok) {
                                status.innerHTML = 'Small download test successful! Check your downloads.';
                                status.style.background = '#d4edda';
                                status.style.color = '#155724';
                            } else {
                                status.innerHTML = 'Small download test failed: ' + response.status;
                                status.style.background = '#f8d7da';
                                status.style.color = '#721c24';
                            }
                        })
                        .catch(error => {
                            status.innerHTML = 'Error: ' + error.message;
                            status.style.background = '#f8d7da';
                            status.style.color = '#721c24';
                        });
                }
                
                function testDirectDownload() {
                    const status = document.getElementById('direct-status');
                    status.innerHTML = 'Testing direct download...';
                    
                    const link = document.createElement('a');
                    link.href = '/download-file?videoId=dQw4w9WgXcQ&format=mp4&quality=lowest';
                    link.download = '';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    
                    status.innerHTML = 'Direct download triggered! Check your downloads.';
                    status.style.background = '#d4edda';
                    status.style.color = '#155724';
                }
            </script>
        </body>
        </html>
    `);
});

// Download status tracking
const downloadQueue = new Map();
let downloadCounter = 0;

// Lightweight concurrency control for CPU-heavy merge operations
class AsyncSemaphore {
    constructor(max) {
        this.max = typeof max === 'number' && max > 0 ? max : 2;
        this.current = 0;
        this.queue = [];
    }
    async acquire() {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        await new Promise(resolve => this.queue.push(resolve));
        this.current++;
    }
    release() {
        if (this.current > 0) this.current--;
        if (this.queue.length > 0) {
            const resolve = this.queue.shift();
            resolve();
        }
    }
}

const MAX_CONCURRENT_MERGES = parseInt(process.env.MAX_CONCURRENT_MERGES || '2', 10);
const mergeSemaphore = new AsyncSemaphore(MAX_CONCURRENT_MERGES);

// Download status endpoint
app.get('/download-status/:id', (req, res) => {
    const downloadId = req.params.id;
    const downloadInfo = downloadQueue.get(downloadId);

    if (!downloadInfo) {
        return res.status(404).json({ error: 'Download not found' });
    }

    res.json({
        id: downloadId,
        status: downloadInfo.status,
        progress: downloadInfo.progress,
        filename: downloadInfo.filename,
        error: downloadInfo.error
    });
});

// Ultra-efficient streaming download endpoint
app.get('/stream-download', async (req, res) => {
    const videoId = req.query.videoId;
    const format = req.query.format;
    const quality = req.query.quality || 'highest';

    if (!videoId || !format) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (!['mp3', 'mp4'].includes(format)) {
        return res.status(400).json({ error: 'Invalid format. Supported formats are mp3 and mp4' });
    }

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // Validate the video URL
        if (!ytdl.validateURL(videoUrl)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log(`Starting ultra-efficient streaming download of video ${videoId} in ${format} format`);

        // Get video info for filename
        const videoInfo = await ytdl.getInfo(videoUrl);
        const videoTitle = videoInfo.videoDetails.title;
        const sanitizedTitle = videoTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filename = `${sanitizedTitle}.${format}`;

        console.log(`Video title: ${videoTitle}`);
        console.log(`Filename: ${filename}`);

        // Set headers immediately
        res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Transfer-Encoding', 'chunked');

        if (format === 'mp3') {
            // Stream audio directly to MP3 conversion
            console.log('Starting MP3 streaming conversion...');

            const audioStream = ytdl(videoUrl, {
                quality: 'highestaudio',
                filter: 'audioonly'
            });

            const ffmpegProcess = ffmpeg(audioStream)
                .toFormat('mp3')
                .audioBitrate(192)
                .on('start', () => {
                    console.log('Started MP3 streaming conversion');
                })
                .on('progress', (progress) => {
                    console.log(`Conversion progress: ${progress.percent}%`);
                })
                .on('error', (error) => {
                    console.error('FFmpeg error:', error);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Audio conversion failed', details: error.message });
                    }
                })
                .on('end', () => {
                    console.log('MP3 streaming conversion completed');
                });

            // Pipe directly to response
            ffmpegProcess.pipe(res);

            // Handle client disconnect
            req.on('close', () => {
                console.log('Client disconnected during MP3 streaming');
                ffmpegProcess.kill();
            });

        } else {
            // Stream video directly to browser
            console.log('Starting MP4 streaming download...');

            // Fast path (muxed up to ~720p), High path (true 1080p+ by merging A/V)
            const wantsHighMerge = ['1080p', '1440p', '2160p', 'highest'].includes(quality);

            try {
                if (wantsHighMerge) {
                    // Attempt ultra-fast path with yt-dlp piping first
                    try {
                        console.log('Trying yt-dlp streaming merge path...');
                        const ytdlpProc = ytdlp.raw(videoUrl, {
                            format: 'bv*[ext=mp4]+ba[ext=m4a]/best',
                            mergeOutputFormat: 'mp4',
                            remuxVideo: 'mp4',
                            httpChunkSize: '10M',
                            concurrentFragments: 8,
                            output: '-',
                            noWarnings: true,
                            verbose: false
                        }, { stdio: ['ignore', 'pipe', 'pipe'] });

                        if (!ytdlpProc || !ytdlpProc.stdout) {
                            throw new Error('yt-dlp did not return a readable stdout stream');
                        }

                        ytdlpProc.stdout.on('error', (e) => {
                            console.error('yt-dlp stdout error:', e.message);
                        });
                        if (ytdlpProc.stderr && ytdlpProc.stderr.on) {
                            ytdlpProc.stderr.on('data', chunk => {
                                const s = chunk.toString();
                                if (s.toLowerCase().includes('error')) console.error('yt-dlp:', s.trim());
                            });
                        }

                        // Pipe output directly to client
                        ytdlpProc.stdout.pipe(res);
                        ytdlpProc.on('close', (code) => {
                            if (code === 0) {
                                console.log('yt-dlp stream completed');
                            } else {
                                console.warn('yt-dlp exited non-zero, code:', code);
                                try { res.end(); } catch (_) { }
                            }
                        });

                        req.on('close', () => {
                            try { ytdlpProc.kill('SIGKILL'); } catch (_) { }
                        });

                        return; // served by yt-dlp
                    } catch (ydErr) {
                        console.warn('yt-dlp path failed, falling back to ffmpeg merge:', ydErr.message);
                    }
                    console.log('High-quality merge mode selected');
                    // Fetch formats and pick best matching ones
                    const info = await ytdl.getInfo(videoUrl);

                    const pickBestVideo = () => {
                        const videoOnly = ytdl.filterFormats(info.formats, 'videoonly');
                        // Prefer H.264 in MP4 container for copy
                        const h264 = videoOnly.filter(f => (f.codecs || '').includes('avc1') && f.container === 'mp4');
                        let candidates = h264.length ? h264 : videoOnly;
                        if (quality !== 'highest') {
                            const exact = candidates.filter(f => f.qualityLabel === quality);
                            if (exact.length) candidates = exact;
                        }
                        candidates.sort((a, b) => (b.height || 0) - (a.height || 0));
                        return candidates[0] || null;
                    };

                    const pickBestAudio = () => {
                        // Prefer English/default audio when multiple tracks exist
                        const preferredLang = (req.headers['x-prefer-audio-lang'] || process.env.PREFERRED_AUDIO_LANG || 'auto').toString();
                        const best = pickBestAudioFormat(info.formats, preferredLang);
                        if (best) return best;
                        const audioOnly = ytdl.filterFormats(info.formats, 'audioonly');
                        const aac = audioOnly.filter(f => (f.codecs || '').includes('mp4a') && f.container === 'mp4');
                        const candidates = (aac.length ? aac : audioOnly).sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
                        return candidates[0] || null;
                    };

                    const videoFormat = pickBestVideo();
                    const audioFormat = pickBestAudio();

                    if (videoFormat?.url && audioFormat?.url) {
                        res.setHeader('X-Quality-Selected', videoFormat.qualityLabel || 'unknown');
                        console.log('Selected formats:', {
                            video: { itag: videoFormat.itag, container: videoFormat.container, codecs: videoFormat.codecs, q: videoFormat.qualityLabel },
                            audio: { itag: audioFormat.itag, container: audioFormat.container, codecs: audioFormat.codecs, abr: audioFormat.audioBitrate }
                        });

                        // Use direct format URLs instead of two Node streams.
                        // fluent-ffmpeg supports only one input stream; multiple stream inputs cause errors on Windows.
                        await mergeSemaphore.acquire();
                        const ff = ffmpeg()
                            .addInput(videoFormat.url)
                            .addInput(audioFormat.url)
                            .inputOptions([
                                '-reconnect 1',
                                '-reconnect_streamed 1',
                                '-reconnect_delay_max 2',
                                '-user_agent',
                                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                                '-protocol_whitelist',
                                'file,https,http,tcp,tls'
                            ])
                            .on('start', cmd => console.log('FFmpeg (merge) start:', cmd))
                            .on('stderr', line => console.log('FFmpeg (merge) stderr:', line))
                            .on('progress', p => {
                                if (p.percent && Math.round(p.percent) % 10 === 0) {
                                    console.log(`FFmpeg (merge) progress: ${Math.round(p.percent)}%`);
                                }
                            })
                            .on('error', err => {
                                console.error('FFmpeg (merge) error:', err.message);
                                // Graceful fallback to fast path progressive stream if possible
                                try { mergeSemaphore.release(); } catch (_) { }
                                try {
                                    if (!res.headersSent) {
                                        console.log('Falling back to fast path (muxed progressive stream)');
                                        // Reuse fast path
                                        let videoOptions = { quality: 'highest', filter: 'videoandaudio', highWaterMark: 1 << 20, dlChunkSize: 0 };
                                        switch (quality) {
                                            case '144p': videoOptions.quality = 'lowest'; break;
                                            case '360p': videoOptions.quality = 'low'; break;
                                            case '480p': videoOptions.quality = 'medium'; break;
                                            case '720p': videoOptions.quality = 'high'; break;
                                            default: videoOptions.quality = 'highest'; break;
                                        }
                                        const fallbackStream = ytdl(videoUrl, videoOptions);
                                        fallbackStream.on('error', (e) => {
                                            console.error('Fallback stream error:', e.message);
                                            if (!res.headersSent) {
                                                res.status(500).json({ error: 'Streaming failed', details: e.message });
                                            }
                                        });
                                        fallbackStream.pipe(res);
                                        req.on('close', () => { try { fallbackStream.destroy(); } catch (_) { } });
                                    }
                                } catch (e) {
                                    if (!res.headersSent) {
                                        res.status(500).json({ error: 'Video merge failed', details: err.message });
                                    }
                                }
                            })
                            .on('end', () => console.log('FFmpeg (merge) completed'))
                            .on('end', () => mergeSemaphore.release())
                            .on('error', () => mergeSemaphore.release());

                        const canCopyVideo = (videoFormat.codecs || '').includes('avc1') && videoFormat.container === 'mp4';
                        const canCopyAudio = (audioFormat.codecs || '').includes('mp4a') && audioFormat.container === 'mp4';

                        if (canCopyVideo) {
                            ff.videoCodec('copy');
                        } else {
                            ff.videoCodec('libx264').outputOptions(['-preset veryfast', '-crf 23']);
                        }
                        if (canCopyAudio) {
                            ff.audioCodec('copy');
                        } else {
                            ff.audioCodec('aac').audioBitrate(192);
                        }

                        ff
                            .outputOptions([
                                '-map 0:v:0',
                                '-map 1:a:0',
                                '-shortest',
                                '-movflags +frag_keyframe+empty_moov',
                                '-bsf:a aac_adtstoasc'
                            ])
                            .format('mp4')
                            .outputOptions(['-max_muxing_queue_size 1024', '-threads 0']);
                        ff.pipe(res, { end: true });

                        // Handle client disconnect
                        req.on('close', () => {
                            try { ff.kill('SIGKILL'); } catch (_) { }
                            try { mergeSemaphore.release(); } catch (_) { }
                        });
                        return; // Done
                    }
                    console.warn('Could not find suitable video/audio formats for merge; falling back to fast path');
                }

                // Fast path: muxed (video+audio) stream, up to ~720p
                // If client supports Range, proxy YouTube progressive URL directly for smooth seeking
                const wantsRange = !!req.headers.range;
                if (wantsRange) {
                    try {
                        const cacheKey = `${videoId}:progressive`;
                        let directUrl = getProgressiveCache(cacheKey);
                        if (!directUrl) {
                            const info = await ytdl.getInfo(videoUrl);
                            const progressive = info.formats
                                .filter(f => f.hasVideo && f.hasAudio && f.isHLS !== true && f.isDashMPD !== true)
                                .filter(f => f.container === 'mp4')
                                .sort((a, b) => (b.height || 0) - (a.height || 0));
                            directUrl = progressive[0]?.url || null;
                            if (directUrl) setProgressiveCache(cacheKey, directUrl);
                        }
                        if (directUrl) {
                            console.log('Proxying progressive URL with Range');
                            const rangeHeaders = { ...req.headers, host: undefined, connection: 'keep-alive' };
                            const upstream = await axiosClient.get(directUrl, { headers: rangeHeaders, responseType: 'stream', family: 4, validateStatus: s => s >= 200 && s < 400 });
                            // Forward range-related headers
                            const hopHeaders = ['accept-ranges', 'content-range', 'content-length', 'content-type'];
                            hopHeaders.forEach(h => { if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]); });
                            res.status(upstream.status);
                            upstream.data.pipe(res);
                            upstream.data.on('error', () => { try { res.end(); } catch (_) { } });
                            req.on('close', () => { try { upstream.data.destroy(); } catch (_) { } });
                            return;
                        }
                    } catch (proxyErr) {
                        console.warn('Progressive proxy failed, using ytdl stream:', proxyErr.message);
                    }
                }

                let videoOptions = { quality: 'highest', filter: 'videoandaudio', highWaterMark: 1 << 24, dlChunkSize: 0 };
                switch (quality) {
                    case '144p':
                        videoOptions.quality = 'lowest';
                        break;
                    case '360p':
                        videoOptions.quality = 'low';
                        break;
                    case '480p':
                        videoOptions.quality = 'medium';
                        break;
                    case '720p':
                        videoOptions.quality = 'high';
                        break;
                    case '1080p':
                    case 'highest':
                    default:
                        videoOptions.quality = 'highest';
                        break;
                }
                console.log('Fast path options:', videoOptions);
                const videoStream = ytdl(videoUrl, videoOptions);

                videoStream.on('error', (error) => {
                    console.error('Video stream error:', error);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Video download failed', details: error.message });
                    }
                });

                let startTime = Date.now();
                let lastProgressTime = Date.now();
                videoStream.on('progress', (chunkLength, downloaded, total) => {
                    const percent = downloaded / total * 100;
                    const elapsed = (Date.now() - startTime) / 1000;
                    const downloadSpeed = downloaded / elapsed;
                    const currentTime = Date.now();
                    if (currentTime - lastProgressTime > 5000) {
                        console.log(`Streaming progress: ${percent.toFixed(1)}% (${(downloaded / 1024 / 1024).toFixed(1)}MB) - ${(downloadSpeed / 1024 / 1024).toFixed(1)}MB/s`);
                        lastProgressTime = currentTime;
                    }
                });

                let dataReceived = false;
                videoStream.on('data', () => {
                    if (!dataReceived) {
                        console.log('First chunk received, streaming is flowing...');
                        dataReceived = true;
                    }
                });

                const streamTimeout = setTimeout(() => {
                    console.log('Stream timeout reached, cleaning up...');
                    videoStream.destroy();
                    if (!res.headersSent) {
                        res.status(408).json({ error: 'Stream timeout', details: 'The download took too long' });
                    }
                }, 900000);

                videoStream.pipe(res);
                req.on('close', () => {
                    console.log('Client disconnected during streaming, cleaning up...');
                    clearTimeout(streamTimeout);
                    videoStream.destroy();
                });
                videoStream.on('end', () => clearTimeout(streamTimeout));
            } catch (err) {
                console.error('Streaming pipeline error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Streaming failed', details: err.message });
                }
            }
        }

    } catch (error) {
        console.error('Streaming download error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Error starting streaming download',
                details: error.message
            });
        }
    }
});

// Download completion endpoint - serves already downloaded files
app.get('/download-complete/:downloadId', (req, res) => {
    const downloadId = req.params.downloadId;
    const downloadInfo = downloadQueue.get(downloadId);

    if (!downloadInfo) {
        return res.status(404).json({ error: 'Download not found or expired' });
    }

    if (downloadInfo.status !== 'ready') {
        return res.status(400).json({ error: 'Download not ready yet', status: downloadInfo.status });
    }

    // Find the temporary file
    const tempDir = os.tmpdir();
    const tempFiles = fs.readdirSync(tempDir).filter(file => file.startsWith('youtube_download_'));

    let tempFilePath = null;
    for (const file of tempFiles) {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);
        // Check if this file was created recently and matches our download
        if (stats.mtime > new Date(Date.now() - 300000)) { // Within last 5 minutes
            tempFilePath = filePath;
            break;
        }
    }

    if (!tempFilePath || !fs.existsSync(tempFilePath)) {
        return res.status(404).json({ error: 'Downloaded file not found' });
    }

    const stats = fs.statSync(tempFilePath);
    if (stats.size === 0) {
        return res.status(500).json({ error: 'Downloaded file is empty' });
    }

    // Set headers for download
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadInfo.filename}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    console.log(`Serving completed download: ${downloadInfo.filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    const fileStream = fs.createReadStream(tempFilePath);

    // Handle file stream errors
    fileStream.on('error', (error) => {
        console.error('File stream error:', error);
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
    });

    // Pipe file to response
    fileStream.pipe(res);

    // Clean up temp file after sending
    fileStream.on('end', () => {
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
            console.log('Temporary MP4 file cleaned up');
        }
        // Clean up download tracking
        if (downloadQueue.has(downloadId)) {
            downloadQueue.delete(downloadId);
        }
        console.log(`✅ Download ${downloadId} completed successfully and sent to client`);
    });

    // Handle response finish/close/error
    const cleanup = () => {
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
            console.log('Temporary MP4 file cleaned up (response closed/error)');
        }
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
});

// Download Route
app.get('/download', async (req, res) => {
    const videoId = req.query.videoId;
    const format = req.query.format;
    const quality = req.query.quality || 'highest';

    if (!videoId || !format) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (!['mp3', 'mp4'].includes(format)) {
        return res.status(400).json({ error: 'Invalid format. Supported formats are mp3 and mp4' });
    }

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // Validate the video URL
        if (!ytdl.validateURL(videoUrl)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log(`Starting download of video ${videoId} in ${format} format with quality ${quality}`);

        // Get video info first
        const videoInfo = await ytdl.getInfo(videoUrl);
        const videoTitle = videoInfo.videoDetails.title;

        // Sanitize filename by removing special characters
        const sanitizedTitle = videoTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filename = `${sanitizedTitle}.${format}`;

        console.log(`Video title: ${videoTitle}`);
        console.log(`Filename: ${filename}`);

        // Set appropriate headers for better browser compatibility
        res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Accept-Ranges', 'bytes');

        if (format === 'mp3') {
            // For MP3, we need to download audio and convert it
            console.log('Starting MP3 download and conversion...');

            const audioStream = ytdl(videoUrl, {
                quality: 'highestaudio',
                filter: 'audioonly'
            });

            // Use ffmpeg to convert to MP3
            const ffmpegProcess = ffmpeg(audioStream)
                .toFormat('mp3')
                .audioBitrate(192)
                .on('start', () => {
                    console.log('Started MP3 conversion');
                })
                .on('progress', (progress) => {
                    console.log(`Conversion progress: ${progress.percent}%`);
                })
                .on('error', (error) => {
                    console.error('FFmpeg error:', error);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Audio conversion failed', details: error.message });
                    }
                })
                .on('end', () => {
                    console.log('MP3 conversion completed');
                });

            // Pipe the converted audio to the response
            ffmpegProcess.pipe(res);

            // Handle client disconnect
            req.on('close', () => {
                console.log('Client disconnected, but allowing download to complete...');
                // Only update status if download hasn't started sending yet
                if (!res.headersSent && downloadQueue.has(downloadId)) {
                    downloadQueue.get(downloadId).status = 'cancelled';
                }
                // Clear timeout but don't destroy streams or delete file
                clearTimeout(downloadTimeout);
            });

        } else {
            // For MP4, download video directly with better handling
            console.log('Starting MP4 download...');

            let videoOptions = {
                quality: 'highest',
                filter: 'videoandaudio',
                highWaterMark: 1 << 24,
                dlChunkSize: 0
            };

            // Set quality based on user selection
            switch (quality) {
                case '144p':
                    videoOptions.quality = 'lowest';
                    break;
                case '360p':
                    videoOptions.quality = 'low';
                    break;
                case '480p':
                    videoOptions.quality = 'medium';
                    break;
                case '720p':
                    videoOptions.quality = 'high';
                    break;
                case '1080p':
                case 'highest':
                default:
                    videoOptions.quality = 'highest';
                    break;
            }

            console.log('Video options:', videoOptions);

            const videoStream = ytdl(videoUrl, videoOptions);
            // Try to nudge YouTube CDN with a modern UA
            videoStream.once('request', (req) => {
                try { req.setHeader('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'); } catch (_) { }
            });

            // Handle stream errors
            videoStream.on('error', (error) => {
                console.error('Video download error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Video download failed', details: error.message });
                }
            });

            // Handle progress with better logging
            let startTime = Date.now();
            let lastProgressTime = Date.now();
            let lastDownloaded = 0;
            let lastProgressCheck = Date.now();

            videoStream.on('progress', (chunkLength, downloaded, total) => {
                const percent = downloaded / total * 100;
                const elapsed = (Date.now() - startTime) / 1000;
                const downloadSpeed = downloaded / elapsed;
                const currentTime = Date.now();

                // Log progress every 2 seconds to avoid spam
                if (currentTime - lastProgressTime > 2000) {
                    console.log(`Download progress: ${percent.toFixed(2)}% (${(downloaded / 1024 / 1024).toFixed(2)}MB / ${(total / 1024 / 1024).toFixed(2)}MB) - ${(downloadSpeed / 1024 / 1024).toFixed(2)}MB/s`);
                    lastProgressTime = currentTime;
                }

                // Check if download is stuck (no progress for 15 seconds)
                if (downloaded === lastDownloaded && (currentTime - lastProgressCheck) > 15000) {
                    console.warn('Download appears to be stuck, attempting to restart...');
                    videoStream.destroy();
                    if (!res.headersSent) {
                        res.status(408).json({ error: 'Download timeout', details: 'Download appears to be stuck' });
                    }
                } else if (downloaded > lastDownloaded) {
                    // Update last downloaded and reset progress check timer
                    lastDownloaded = downloaded;
                    lastProgressCheck = currentTime;
                }
            });

            // Handle completion
            videoStream.on('end', () => {
                console.log('Video download completed successfully');
            });

            // Handle data events to ensure stream is flowing
            let dataReceived = false;
            videoStream.on('data', (chunk) => {
                if (!dataReceived) {
                    console.log('First chunk received, download is flowing...');
                    dataReceived = true;
                }
            });

            // Set up timeout for the entire download
            const downloadTimeout = setTimeout(() => {
                console.log('Download timeout reached, cleaning up...');
                videoStream.destroy();
                if (!res.headersSent) {
                    res.status(408).json({ error: 'Download timeout', details: 'The download took too long' });
                }
            }, 300000); // 5 minute timeout

            // Pipe the video stream to the response
            videoStream.pipe(res);

            // Handle client disconnect
            req.on('close', () => {
                console.log('Client disconnected, but allowing download to complete...');
                // Only update status if download hasn't started sending yet
                if (!res.headersSent && downloadQueue.has(downloadId)) {
                    downloadQueue.get(downloadId).status = 'cancelled';
                }
                // Clear timeout but don't destroy streams or delete file
                clearTimeout(downloadTimeout);
            });
        }

    } catch (error) {
        console.error('Download error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Error downloading video',
                details: error.message
            });
        }
    }
});

// Alternative Download Route (more reliable for large files)
app.get('/download-file', async (req, res) => {
    const videoId = req.query.videoId;
    const format = req.query.format;
    const quality = req.query.quality || 'highest';

    if (!videoId || !format) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (!['mp3', 'mp4'].includes(format)) {
        return res.status(400).json({ error: 'Invalid format. Supported formats are mp3 and mp4' });
    }

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // Validate the video URL
        if (!ytdl.validateURL(videoUrl)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log(`Starting file-based download of video ${videoId} in ${format} format with quality ${quality}`);

        // Get video info first
        const videoInfo = await ytdl.getInfo(videoUrl);
        const videoTitle = videoInfo.videoDetails.title;

        // Sanitize filename by removing special characters
        const sanitizedTitle = videoTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filename = `${sanitizedTitle}.${format}`;

        console.log(`Video title: ${videoTitle}`);
        console.log(`Filename: ${filename}`);

        // Create download ID for tracking
        const downloadId = `download_${++downloadCounter}`;

        // Initialize download tracking
        downloadQueue.set(downloadId, {
            status: 'preparing',
            progress: 0,
            filename: filename,
            error: null
        });

        // Create temporary file path
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `youtube_download_${Date.now()}.${format}`);

        console.log(`Temporary file path: ${tempFilePath}`);

        // Update status to downloading
        if (downloadQueue.has(downloadId)) {
            downloadQueue.get(downloadId).status = 'downloading';
        }

        if (format === 'mp3') {
            // For MP3, download audio and convert
            console.log('Starting MP3 download and conversion...');

            const audioStream = ytdl(videoUrl, {
                quality: 'highestaudio',
                filter: 'audioonly'
            });

            // Use ffmpeg to convert to MP3 and save to temp file
            const ffmpegProcess = ffmpeg(audioStream)
                .toFormat('mp3')
                .audioBitrate(192)
                .output(tempFilePath)
                .on('start', () => {
                    console.log('Started MP3 conversion');
                    if (downloadQueue.has(downloadId)) {
                        downloadQueue.get(downloadId).status = 'converting';
                    }
                })
                .on('progress', (progress) => {
                    console.log(`Conversion progress: ${progress.percent}%`);
                    if (downloadQueue.has(downloadId)) {
                        downloadQueue.get(downloadId).progress = progress.percent;
                    }
                })
                .on('error', (error) => {
                    console.error('FFmpeg error:', error);
                    if (downloadQueue.has(downloadId)) {
                        downloadQueue.get(downloadId).status = 'error';
                        downloadQueue.get(downloadId).error = error.message;
                    }
                    // Clean up temp file
                    if (fs.existsSync(tempFilePath)) {
                        fs.unlinkSync(tempFilePath);
                    }
                    if (!res.headersSent) {
                        res.status(500).json({
                            error: 'Audio conversion failed',
                            details: error.message,
                            downloadId: downloadId
                        });
                    }
                })
                .on('end', () => {
                    console.log('MP3 conversion completed');
                    if (downloadQueue.has(downloadId)) {
                        downloadQueue.get(downloadId).status = 'ready';
                        downloadQueue.get(downloadId).progress = 100;
                    }

                    // Send the file
                    res.setHeader('Content-Type', 'audio/mpeg');
                    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

                    const fileStream = fs.createReadStream(tempFilePath);
                    fileStream.pipe(res);

                    // Clean up temp file after sending
                    fileStream.on('end', () => {
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                            console.log('Temporary MP3 file cleaned up');
                        }
                        // Clean up download tracking
                        if (downloadQueue.has(downloadId)) {
                            downloadQueue.delete(downloadId);
                        }
                        console.log(`✅ Download ${downloadId} completed successfully and sent to client`);
                    });
                });

            ffmpegProcess.run();

        } else {
            // For MP4, download video to temp file first
            console.log('Starting MP4 download to temporary file...');

            let videoOptions = {
                quality: 'highest',
                filter: 'videoandaudio'
            };

            // Set quality based on user selection
            switch (quality) {
                case '144p':
                    videoOptions.quality = 'lowest';
                    break;
                case '360p':
                    videoOptions.quality = 'low';
                    break;
                case '480p':
                    videoOptions.quality = 'medium';
                    break;
                case '720p':
                    videoOptions.quality = 'high';
                    break;
                case '1080p':
                case 'highest':
                default:
                    videoOptions.quality = 'highest';
                    break;
            }

            console.log('Video options:', videoOptions);

            const videoStream = ytdl(videoUrl, videoOptions);
            const writeStream = fs.createWriteStream(tempFilePath);

            // Handle progress with better tracking
            let startTime = Date.now();
            let lastProgressTime = Date.now();
            let lastDownloaded = 0;
            let lastProgressCheck = Date.now();
            let retryCount = 0;
            const maxRetries = 2;

            videoStream.on('progress', (chunkLength, downloaded, total) => {
                const percent = downloaded / total * 100;
                const elapsed = (Date.now() - startTime) / 1000;
                const downloadSpeed = downloaded / elapsed;
                const currentTime = Date.now();

                // Update download tracking
                if (downloadQueue.has(downloadId)) {
                    downloadQueue.get(downloadId).progress = percent;
                }

                // Log progress every 2 seconds
                if (currentTime - lastProgressTime > 2000) {
                    console.log(`Download progress: ${percent.toFixed(2)}% (${(downloaded / 1024 / 1024).toFixed(2)}MB / ${(total / 1024 / 1024).toFixed(2)}MB) - ${(downloadSpeed / 1024 / 1024).toFixed(2)}MB/s`);
                    lastProgressTime = currentTime;
                }

                // Check if download is stuck (no progress for 20 seconds)
                if (downloaded === lastDownloaded && (currentTime - lastProgressCheck) > 20000) {
                    console.warn(`Download appears to be stuck, retry ${retryCount + 1}/${maxRetries + 1}...`);

                    if (retryCount < maxRetries) {
                        retryCount++;
                        // Restart download with same options
                        videoStream.destroy();
                        writeStream.end();

                        // Clean up temp file
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                        }

                        // Retry after a short delay
                        setTimeout(() => {
                            console.log(`Retrying download (attempt ${retryCount + 1})...`);
                            const retryStream = ytdl(videoUrl, videoOptions);
                            const retryWriteStream = fs.createWriteStream(tempFilePath);

                            // Reset progress tracking
                            startTime = Date.now();
                            lastProgressTime = Date.now();
                            lastDownloaded = 0;
                            lastProgressCheck = Date.now();

                            // Re-attach event handlers
                            retryStream.on('progress', videoStream.listeners('progress')[0]);
                            retryStream.on('end', () => {
                                console.log('Video download to temp file completed (retry)');
                                retryWriteStream.end();
                                if (downloadQueue.has(downloadId)) {
                                    downloadQueue.get(downloadId).status = 'ready';
                                    downloadQueue.get(downloadId).progress = 100;
                                }
                            });
                            retryStream.on('error', (error) => {
                                console.error('Video download error (retry):', error);
                                if (downloadQueue.has(downloadId)) {
                                    downloadQueue.get(downloadId).status = 'error';
                                    downloadQueue.get(downloadId).error = error.message;
                                }
                                retryWriteStream.end();
                                if (fs.existsSync(tempFilePath)) {
                                    fs.unlinkSync(tempFilePath);
                                }
                                if (!res.headersSent) {
                                    res.status(500).json({
                                        error: 'Video download failed after retries',
                                        details: error.message,
                                        downloadId: downloadId
                                    });
                                }
                            });

                            retryStream.pipe(retryWriteStream);
                        }, 1000);
                    } else {
                        console.error('Download failed after maximum retries');
                        videoStream.destroy();
                        writeStream.end();
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                        }
                        if (downloadQueue.has(downloadId)) {
                            downloadQueue.get(downloadId).status = 'error';
                            downloadQueue.get(downloadId).error = 'Download failed after maximum retries';
                        }
                        if (!res.headersSent) {
                            res.status(500).json({
                                error: 'Download failed after maximum retries',
                                downloadId: downloadId
                            });
                        }
                    }
                } else if (downloaded > lastDownloaded) {
                    // Update last downloaded and reset progress check timer
                    lastDownloaded = downloaded;
                    lastProgressCheck = currentTime;
                }
            });

            // Handle completion
            videoStream.on('end', () => {
                console.log('Video download to temp file completed');
                writeStream.end();
                if (downloadQueue.has(downloadId)) {
                    downloadQueue.get(downloadId).status = 'ready';
                    downloadQueue.get(downloadId).progress = 100;
                }
            });

            // Handle errors
            videoStream.on('error', (error) => {
                console.error('Video download error:', error);
                if (downloadQueue.has(downloadId)) {
                    downloadQueue.get(downloadId).status = 'error';
                    downloadQueue.get(downloadId).error = error.message;
                }
                writeStream.end();
                // Clean up temp file
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
                if (!res.headersSent) {
                    res.status(500).json({
                        error: 'Video download failed',
                        details: error.message,
                        downloadId: downloadId
                    });
                }
            });

            // Pipe video to temp file
            videoStream.pipe(writeStream);

            // Set up timeout for the entire download process
            const downloadTimeout = setTimeout(() => {
                console.log('Download timeout reached, cleaning up...');
                videoStream.destroy();
                writeStream.end();
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
                if (downloadQueue.has(downloadId)) {
                    downloadQueue.get(downloadId).status = 'error';
                    downloadQueue.get(downloadId).error = 'Download timeout';
                }
                if (!res.headersSent) {
                    res.status(408).json({
                        error: 'Download timeout',
                        details: 'The download took too long',
                        downloadId: downloadId
                    });
                }
            }, 600000); // 10 minute timeout

            // When write stream finishes, redirect to completion endpoint
            writeStream.on('finish', () => {
                clearTimeout(downloadTimeout);
                console.log('Temp file written, redirecting to completion endpoint...');

                // Check if file exists and has content
                if (fs.existsSync(tempFilePath)) {
                    const stats = fs.statSync(tempFilePath);
                    if (stats.size > 0) {
                        // Update download status to ready
                        if (downloadQueue.has(downloadId)) {
                            downloadQueue.get(downloadId).status = 'ready';
                            downloadQueue.get(downloadId).progress = 100;
                        }

                        console.log(`Download ready: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

                        // Redirect to completion endpoint
                        res.redirect(`/download-complete/${downloadId}`);
                    } else {
                        if (downloadQueue.has(downloadId)) {
                            downloadQueue.get(downloadId).status = 'error';
                            downloadQueue.get(downloadId).error = 'Downloaded file is empty';
                        }
                        res.status(500).json({
                            error: 'Downloaded file is empty',
                            downloadId: downloadId
                        });
                    }
                } else {
                    if (downloadQueue.has(downloadId)) {
                        downloadQueue.get(downloadId).status = 'error';
                        downloadQueue.get(downloadId).error = 'Temporary file not found';
                    }
                    res.status(500).json({
                        error: 'Temporary file not found',
                        downloadId: downloadId
                    });
                }
            });

            // Handle client disconnect
            req.on('close', () => {
                console.log('Client disconnected, but allowing download to complete...');
                // Only update status if download hasn't started sending yet
                if (!res.headersSent && downloadQueue.has(downloadId)) {
                    downloadQueue.get(downloadId).status = 'cancelled';
                }
                // Clear timeout but don't destroy streams or delete file
                clearTimeout(downloadTimeout);
            });
        }

    } catch (error) {
        console.error('Download error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Error downloading video',
                details: error.message
            });
        }
    }
});

// Add new route for video link playback
app.get('/play-video', async (req, res) => {
    const videoUrl = req.query.url;

    if (!videoUrl) {
        return res.status(400).json({ error: 'No video URL provided' });
    }

    const videoId = extractVideoId(videoUrl);

    if (!videoId) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    try {
        // Get video details from YouTube API
        const videoResponse = await optimizedApiCall('videos', {
            part: 'snippet',
            id: videoId
        });

        if (!videoResponse.items || videoResponse.items.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const video = videoResponse.items[0];
        const videoData = {
            id: videoId,
            title: video.snippet.title,
            description: video.snippet.description,
            thumbnail: video.snippet.thumbnails.high.url,
            url: `https://www.youtube.com/watch?v=${videoId}`
        };

        // Render the index page with the video data
        res.render('index', {
            videos: [],
            nextPageToken: null,
            query: '',
            playVideo: true,
            currentVideo: videoData
        });
    } catch (error) {
        console.error('Error fetching video details:', error.message);
        res.status(500).json({ error: 'Error fetching video details' });
    }
});

// API endpoint to get video details by ID
app.get('/api/video-details', async (req, res) => {
    const videoId = req.query.videoId;

    if (!videoId) {
        return res.status(400).json({
            success: false,
            error: 'Video ID is required'
        });
    }

    try {
        const videoResponse = await optimizedApiCall('videos', {
            part: 'snippet',
            id: videoId
        });

        if (!videoResponse.items || videoResponse.items.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Video not found'
            });
        }

        const video = videoResponse.items[0];
        const videoData = {
            id: videoId,
            title: video.snippet.title,
            description: video.snippet.description,
            thumbnail: video.snippet.thumbnails.high.url,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            channelTitle: video.snippet.channelTitle,
            publishedAt: video.snippet.publishedAt
        };

        res.json({
            success: true,
            video: videoData
        });

    } catch (error) {
        console.error('Error fetching video details:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch video details'
        });
    }
});

// Test API endpoint
app.get('/api/test', async (req, res) => {
    try {
        const testResponse = await optimizedApiCall('search', {
            part: 'snippet',
            q: 'test',
            type: 'video',
            maxResults: 1
        });

        res.json({
            success: true,
            message: 'API is working correctly',
            data: {
                items: testResponse.items ? testResponse.items.length : 0,
                hasNextPageToken: !!testResponse.nextPageToken,
                quotaUsed: dailyQuotaUsed
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            quotaUsed: dailyQuotaUsed
        });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
