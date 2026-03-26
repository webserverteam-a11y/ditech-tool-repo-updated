FROM node:20-slim

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --production

# Copy application code
COPY . .

# Create data directories
RUN mkdir -p /data /data/audit-logs

# Expose the port Render will use
EXPOSE 10000

# Start the server
CMD ["node", "server.js"]
