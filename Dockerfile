FROM node:20-alpine

RUN apk add --no-cache ffmpeg python3 py3-pip \
  && pip install --no-cache-dir yt-dlp

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]
