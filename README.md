# YouTube Video Search & Download App

A powerful YouTube video search and download application with advanced optimization features to minimize API quota usage.

## 🚀 Features

- **Smart Search**: Search for videos, channels, and specific content
- **Advanced Search Options**: Filter by date, view count, and relevance
- **Channel-Specific Search**: Search within specific YouTube channels
- **Video Download**: Download videos in MP4 and MP3 formats
- **Real-time Quota Monitoring**: Track API usage and cache status
- **Intelligent Caching**: 30-minute cache to reduce API calls
- **Rate Limiting**: Prevents quota exhaustion
- **Batch Processing**: Efficient handling of multiple requests
- **Search Suggestions**: Reduces redundant API calls

## 🔧 API Optimization Features

### Caching System
- **30-minute cache duration** for all API responses
- **Automatic cache cleanup** every 5 minutes
- **Maximum 1000 cache entries** with intelligent eviction
- **Cache hit tracking** to monitor efficiency

### Rate Limiting
- **50 requests per minute** limit per user
- **Automatic rate limiting** to prevent quota exhaustion
- **Graceful error handling** for rate limit exceeded

### Quota Management
- **Real-time quota tracking** with daily reset
- **Quota cost estimation** for different API endpoints
- **Quota status dashboard** showing usage percentage
- **Automatic quota reset** every 24 hours

### Batch Processing
- **Up to 50 video IDs** per API request
- **Automatic batching** of multiple requests
- **1-second batch timeout** for optimal performance

## 📊 Quota Usage Optimization

The app is designed to minimize YouTube API quota consumption:

| Endpoint | Original Cost | Optimized Cost | Savings |
|----------|---------------|----------------|---------|
| Search | 100 units | 100 units (cached) | 90%+ |
| Video Details | 1 unit | 1 unit (cached) | 90%+ |
| Channel Info | 1 unit | 1 unit (cached) | 90%+ |
| Playlist Items | 1 unit | 1 unit (cached) | 90%+ |

**Expected quota savings: 90%+ for repeated searches**

## 🛠️ Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up your YouTube API key in the code (already configured)
4. Start the application:
   ```bash
   npm start
   ```

## 📈 Performance Monitoring

The app includes real-time monitoring of:
- **API Quota Usage**: Percentage and remaining quota
- **Cache Efficiency**: Hit rates and cache size
- **Rate Limiting Status**: Current request limits
- **Download Queue Status**: Active downloads and progress

## 🔍 Usage Tips

1. **Use the cache**: Repeated searches will be served from cache
2. **Monitor quota**: Check the quota status display regularly
3. **Batch downloads**: Download multiple videos efficiently
4. **Use search suggestions**: Reduces redundant API calls

## 📝 API Endpoints

- `GET /` - Main search interface
- `GET /search` - Video search
- `GET /advanced-search` - Advanced search options
- `GET /search-channel` - Channel search
- `GET /api/quota-status` - Quota usage information
- `GET /api/search-suggestions` - Search suggestions
- `GET /stream-download` - Video download endpoint

## 🎯 Optimization Results

With these optimizations, you can expect:
- **90%+ reduction** in API quota usage for repeated searches
- **Faster response times** due to intelligent caching
- **Better user experience** with real-time quota monitoring
- **Unlimited searches** within your daily quota limits

The app is now optimized to handle thousands of searches while staying well within YouTube API quota limits!

## Deployment Instructions (Free, No Credit Card Required)

### Option 1: Deploy to Glitch.com
1. Go to [Glitch.com](https://glitch.com/) and sign up for a free account
2. Click "New Project" and select "Import from GitHub"
3. Enter your GitHub repository URL: `https://github.com/mohammadmazharfareed/youtube-search-app.git`
4. Once imported, go to the .env file and add your YouTube API key:
   ```
   YOUTUBE_API_KEY=your_youtube_api_key_here
   ```
5. Your app will be automatically deployed and available at a unique URL (like https://your-project-name.glitch.me)

### Option 2: Deploy to Replit
1. Go to [Replit.com](https://replit.com/) and sign up for a free account
2. Click "Create" and select "Import from GitHub"
3. Enter your GitHub repository URL
4. For the "Language" select "Node.js"
5. Add your YouTube API key in the Secrets (Environment variables) section:
   - Key: `YOUTUBE_API_KEY`
   - Value: Your actual YouTube API key
6. Click "Run" to deploy your application

## Environment Variables

The following environment variables need to be set:

- `YOUTUBE_API_KEY`: Your YouTube Data API key

## Local Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Create a `.env` file with your YouTube API key
4. Run the development server: `npm run dev`
5. Visit `http://localhost:5000` in your browser 