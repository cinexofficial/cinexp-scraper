FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to fix permission errors during npm install
USER root

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 4000
CMD ["npm", "start"]
