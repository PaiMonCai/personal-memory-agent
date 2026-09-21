FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --package-lock=false

COPY server ./server

EXPOSE 3000
CMD ["npm", "start"]
