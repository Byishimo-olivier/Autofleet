# Backend Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
# Expose uploads for static files
VOLUME ["/app/uploads"]
EXPOSE 5000
CMD ["node", "server.js"]
