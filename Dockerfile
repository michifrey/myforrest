# MyForrest – Node app with ffmpeg for video uploads. Data lives in /app/data.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/app/data PORT=3000
EXPOSE 3000
VOLUME /app/data
CMD ["npm", "start"]
