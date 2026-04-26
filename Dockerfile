FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to fix permission errors during npm install
USER root

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 4000
CMD ["npm", "start"]
