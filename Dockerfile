# ใช้ node alpine
FROM node:20-alpine

# ติดตั้ง yt-dlp + ffmpeg
RUN apk add --no-cache ffmpeg python3 py3-pip \
  && pip install --no-cache-dir yt-dlp

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

EXPOSE 3001

# ✅ เปลี่ยนเป็น dev mode
CMD ["npm", "run", "dev"]
