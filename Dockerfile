# Use a small Node image
FROM node:18-alpine

# Install runtime tools needed by this app
RUN apk add --no-cache ffmpeg yt-dlp

# Create app directory
WORKDIR /app

# Install only what we need first (better caching)
COPY package*.json ./
ENV NODE_ENV=production
RUN npm ci --only=production

# Copy the rest of the app
COPY . .

# Ensure non-root execution
RUN chown -R node:node /app
USER node

# Environment and port
ENV PORT=5000
EXPOSE 5000

# Start the server
CMD ["npm", "start"]
