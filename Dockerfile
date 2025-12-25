FROM apify/actor-node:22

WORKDIR /home/myuser

COPY package*.json ./
RUN npm ci --omit=dev

COPY . ./

ENV APIFY_LOG_LEVEL=INFO

CMD ["npm", "start"]
